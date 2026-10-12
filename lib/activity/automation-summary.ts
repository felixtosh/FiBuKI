import type { AutomationHistoryEntry } from "../../types/transaction";
import { toDateSafe } from "../../functions/src/utils/toDateSafe";

/**
 * The automation ladder in a section header: the methods FiBuKI uses to find
 * a Partner or a connection, left to right in the order it escalates, with
 * the number of log lines each one wrote and the one whose match stands.
 *
 * Read from `automationHistory` and nothing else, so the ladder and the
 * activity log can never disagree. The log records outcomes, not attempts: a
 * step that ran and found nothing wrote no line, so the ladder never claims
 * a step was tried unless the log says so.
 */

/** Every method a ladder can show. */
export type AutomationMethod = "vat" | "rules" | "llm" | "name" | "file" | "magic" | "manual";

/** A section's ladder, and the order its methods escalate in. */
export const LADDERS = {
  /** matchFilePartner: VAT ID (own, global, VIES) → rules → AI lookup → printed name → agent. */
  filePartner: ["vat", "rules", "llm", "name", "magic", "manual"],
  /** Rules pass (with learned patterns) → the connected Files → agent (the company check queues it). */
  transactionPartner: ["rules", "file", "magic", "manual"],
  /** Scoring and auto-connect → the receipt-search agent. Files and Transactions alike. */
  connection: ["rules", "magic", "manual"],
} as const satisfies Record<string, readonly AutomationMethod[]>;

export type AutomationLadder = keyof typeof LADDERS;

const PARTNER_TYPES = new Set([
  "partner_assigned",
  "partner_removed",
  "partner_suggested",
  "company_check",
  "partner_search",
]);

const CONNECTION_TYPES = new Set([
  "file_connected",
  "file_disconnected",
  "transaction_connected",
  "transaction_disconnected",
  "transaction_suggested",
  "connection_confirmed",
  "file_matching",
  "receipt_search",
  "transaction_search",
]);

/** Agent runs, logged once per run by the worker route; `forPartnerId` names a Partner the run created. */
const AGENT_RUN_TYPES = new Set(["partner_search", "receipt_search", "transaction_search"]);

/** The entries that set the match, as opposed to suggesting or removing one. */
const MATCH_TYPES = new Set(["partner_assigned", "file_connected", "transaction_connected"]);

/**
 * Which method wrote a log line. A person comes first; then the step the
 * matcher named in its summary. The summaries are fixed wording in the
 * matchers (matchFilePartner's `via`, the payee rule, the writers), pinned by
 * the test next to this file.
 */
export function automationMethodOf(
  entry: Pick<AutomationHistoryEntry, "type" | "actor" | "summary">,
  ladder: AutomationLadder
): AutomationMethod {
  if (entry.actor === "manual" || entry.actor === "suggestion") return "manual";
  const summary = entry.summary ?? "";

  if (ladder === "connection") {
    if (entry.actor === "ai" || entry.type === "receipt_search") return "magic";
    return "rules";
  }

  if (summary.includes("an AI company lookup")) return "llm";
  if (entry.actor === "ai" || entry.type === "company_check") return "magic";
  if (ladder === "filePartner") {
    if (summary.includes("its VAT ID") || summary.includes("(VIES)")) return "vat";
    if (summary.includes("the name on the document")) return "name";
    return "rules";
  }
  if (summary.includes("taken from the connected File") || summary.includes("taken from the Files still connected")) {
    return "file";
  }
  return "rules";
}

export interface AutomationSummary {
  methods: readonly AutomationMethod[];
  counts: Partial<Record<AutomationMethod, number>>;
  /** The method whose match stands, or null when nothing is matched. */
  matchedBy: AutomationMethod | null;
}

/**
 * Summarise one section of an item's log. `matched` is whether the item holds
 * a match right now; without it no method is green, because a match that was
 * later removed led to nothing.
 */
export function summarizeAutomations(
  entries: AutomationHistoryEntry[] | undefined,
  ladder: AutomationLadder,
  matched: boolean
): AutomationSummary {
  const methods = LADDERS[ladder];
  const types = ladder === "connection" ? CONNECTION_TYPES : PARTNER_TYPES;
  const counts: Partial<Record<AutomationMethod, number>> = {};
  for (const method of methods) counts[method] = 0;
  let matchEntry: AutomationHistoryEntry | null = null;
  let matchTime = -Infinity;

  const agentCreatedPartners = new Set<string>();

  for (const entry of entries ?? []) {
    if (!types.has(entry.type)) continue;
    if (AGENT_RUN_TYPES.has(entry.type) && entry.forPartnerId) agentCreatedPartners.add(entry.forPartnerId);
    // A queue marker is not a run: the run logs itself when it ends.
    if (entry.status === "pending" || entry.type === "company_check") continue;
    const method = automationMethodOf(entry, ladder);
    counts[method] = (counts[method] ?? 0) + 1;
    if (!MATCH_TYPES.has(entry.type) || entry.status === "failed") continue;
    const time = toDateSafe(entry.ranAt)?.getTime() ?? 0;
    if (time >= matchTime) {
      matchTime = time;
      matchEntry = entry;
    }
  }

  // A Partner the agent created for this item is the agent's match, whoever
  // assigned it afterwards (the rules on the new Partner, an open panel).
  const matchedBy = !matched || !matchEntry
    ? null
    : ladder !== "connection" && matchEntry.forPartnerId && agentCreatedPartners.has(matchEntry.forPartnerId)
      ? "magic"
      : automationMethodOf(matchEntry, ladder);
  return { methods, counts, matchedBy };
}
