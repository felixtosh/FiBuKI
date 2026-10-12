/**
 * The chat agent's trajectory guard: tool calls that make no sense at this
 * step are refused in code, before they run, whatever model proposed them.
 *
 * The prompt asks for the same things, and a strong model mostly follows it.
 * A weaker or self-hosted model follows long recipes poorly, so the rules that
 * protect the User's data live here instead (docs/buki-rubric.md, Trajectory):
 *
 * - An id must come from somewhere: a tool result, the User's own words or the
 *   page the User has open. An invented id is the most common way a model
 *   fails silently ("Not found" on nine rows, or worse, a real id it guessed).
 * - A Partner is created only after the existing Partners were searched and
 *   the company was looked up.
 * - A File the agent just downloaded is connected only after its extraction
 *   was read, so the connect is checked against what the document says.
 * - The same call with the same arguments is not run a third time in a row.
 *
 * A refused call is answered with a tool result that says what to do first,
 * so the model can correct itself in the next round.
 */

import type { BaseMessage } from "@langchain/core/messages";

export interface ProposedToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GuardRefusal {
  /** Machine-readable rule, also recorded in the trace. */
  guard: "ungrounded_id" | "partner_not_searched" | "extraction_not_read" | "repeated_call";
  error: string;
}

/** Argument keys that end in "Id" but hold a value, not a record's id. */
const NOT_A_RECORD_ID = new Set(["vatId", "extractedVatId", "noReceiptCategoryTemplateId", "templateId"]);

/** Tools whose ids come from outside the User's records, or that take none. */
const ID_CHECK_EXEMPT = new Set(["presentChoices", "navigateTo"]);

const DOWNLOAD_TOOLS = new Set(["downloadGmailAttachment", "convertEmailToPdf"]);

type AnyMessage = BaseMessage & {
  tool_calls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  tool_call_id?: string;
};

function typeOf(m: BaseMessage): string {
  return (m as { _getType?: () => string })._getType?.() ?? "";
}

function textOf(m: BaseMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === "string" ? b : "text" in b ? String(b.text ?? "") : JSON.stringify(b))).join("\n");
  }
  return JSON.stringify(c ?? "");
}

/** The record ids a call names: string `...Id` arguments and string arrays under `...Ids`. */
export function idsInArgs(args: Record<string, unknown>): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (NOT_A_RECORD_ID.has(key)) continue;
    if (/Id$/.test(key) && typeof value === "string" && value.trim()) out.push({ key, value });
    if (/Ids$/.test(key) && Array.isArray(value)) {
      for (const v of value) if (typeof v === "string" && v.trim()) out.push({ key, value: v });
    }
  }
  return out;
}

/** The ids in the actions of a presentChoices call's options (actionArgs is a JSON object as text). */
function choiceActionIds(args: Record<string, unknown>): Array<{ key: string; value: string }> {
  const options = Array.isArray(args.options) ? args.options : [];
  return options.flatMap((o) => {
    const raw = (o as { actionArgs?: unknown })?.actionArgs;
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? idsInArgs(parsed) : [];
    } catch {
      return [];
    }
  });
}

/** Every tool call the conversation made, with its result text when it has one. */
function pastCalls(history: BaseMessage[]): Array<{ name: string; args: Record<string, unknown>; result?: string }> {
  const results = new Map<string, string>();
  for (const m of history) {
    if (typeOf(m) === "tool") results.set((m as AnyMessage).tool_call_id ?? "", textOf(m));
  }
  const calls: Array<{ name: string; args: Record<string, unknown>; result?: string }> = [];
  for (const m of history) {
    if (typeOf(m) !== "ai") continue;
    for (const tc of (m as AnyMessage).tool_calls ?? []) {
      calls.push({ name: tc.name, args: tc.args ?? {}, result: tc.id ? results.get(tc.id) : undefined });
    }
  }
  return calls;
}

function failed(result: string | undefined): boolean {
  if (!result) return true;
  return /"error"\s*:\s*"/.test(result) || /"guard"\s*:/.test(result);
}

/**
 * Check the calls the model proposes against the conversation so far.
 *
 * `grounding` is the text an id may legitimately come from besides the
 * history: the system prompt's context block (the page the User has open).
 * Returns one refusal per refused call id; calls not in the map may run.
 */
export function checkToolCalls(
  proposed: ProposedToolCall[],
  history: BaseMessage[],
  grounding = ""
): Map<string, GuardRefusal> {
  const refusals = new Map<string, GuardRefusal>();

  // What an id may come from: tool results, the User's messages, the context.
  const sources: string[] = [grounding];
  for (const m of history) {
    const t = typeOf(m);
    if (t === "tool" || t === "human") sources.push(textOf(m));
  }
  const haystack = sources.join("\n");
  const calls = pastCalls(history);
  const succeeded = calls.filter((c) => !failed(c.result));

  proposed.forEach((call, index) => {
    const key = call.id ?? `#${index}`;

    // 1. Grounded ids, including those of the actions a choice would run on a click.
    if (!ID_CHECK_EXEMPT.has(call.name) || call.name === "presentChoices") {
      const named = call.name === "presentChoices" ? choiceActionIds(call.args) : idsInArgs(call.args);
      const invented = named.filter(({ value }) => !haystack.includes(value));
      if (invented.length > 0) {
        refusals.set(key, {
          guard: "ungrounded_id",
          error:
            `Refused: ${invented.map((i) => `${i.key} "${i.value}"`).join(", ")} appeared in no tool result, ` +
            "user message or page context. Never construct or guess ids: look the record up first " +
            "(listTransactions, listFiles, listPartners, getTransaction, getFile) and copy its id exactly.",
        });
        return;
      }
    }

    // 2. A Partner is created only after searching the existing ones and looking the company up.
    if (call.name === "createPartner") {
      const searched = succeeded.some((c) => c.name === "listPartners");
      const lookedUp = succeeded.some((c) => c.name === "lookupCompanyInfo" || c.name === "validateVatId");
      if (!searched || !lookedUp) {
        refusals.set(key, {
          guard: "partner_not_searched",
          error:
            "Refused: before createPartner, " +
            [!searched ? "search the existing partners with listPartners (name variants, VAT ID, IBAN)" : "",
             !lookedUp ? "verify the company with lookupCompanyInfo (or validateVatId for a VAT ID)" : ""]
              .filter(Boolean)
              .join(" and ") +
            ". A duplicate Partner is worse than none.",
        });
        return;
      }
    }

    // 3. A File the agent downloaded is connected only once its extraction was read.
    if (call.name === "connectFileToTransaction" && typeof call.args.fileId === "string") {
      const fileId = call.args.fileId;
      const downloadedHere = succeeded.some((c) => DOWNLOAD_TOOLS.has(c.name) && (c.result ?? "").includes(fileId));
      const extractionRead = succeeded.some(
        (c) => c.name === "waitForFileExtraction" && c.args.fileId === fileId
      );
      if (downloadedHere && !extractionRead) {
        refusals.set(key, {
          guard: "extraction_not_read",
          error:
            `Refused: file ${fileId} was just downloaded. Run waitForFileExtraction({ fileId: "${fileId}" }) and ` +
            "compare its amount, date and partner with the transaction before connecting.",
        });
        return;
      }
    }

    // 4. No third identical call in a row.
    const signature = JSON.stringify([call.name, call.args]);
    const lastTwo = calls.slice(-2).map((c) => JSON.stringify([c.name, c.args]));
    if (lastTwo.length === 2 && lastTwo.every((s) => s === signature)) {
      refusals.set(key, {
        guard: "repeated_call",
        error:
          `Refused: ${call.name} already ran twice with exactly these arguments. Use the result you have, ` +
          "change the arguments, or tell the user what you found.",
      });
    }
  });

  return refusals;
}
