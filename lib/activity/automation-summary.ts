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

/**
 * Agent runs, logged once per run by the worker route. `forPartnerId` names a
 * Partner the run created, `fileId` a File it downloaded.
 */
const AGENT_RUN_TYPES = new Set(["partner_search", "receipt_search", "transaction_search"]);

/** The entries that set the match, as opposed to suggesting or removing one. */
const MATCH_TYPES = new Set(["partner_assigned", "file_connected", "transaction_connected"]);

/** A Partner merge repoints the match; it finds nothing (mergeUserPartners). */
const isMerge = (entry: Pick<AutomationHistoryEntry, "summary">) => (entry.summary ?? "").includes(" merged into ");

/** The File's own line when the receipt-search agent downloaded it (createFileRecord). */
const FOUND_BY_AGENT = "found by the receipt search";

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

  const log = [...(entries ?? [])].sort(
    (a, b) => (toDateSafe(a.ranAt)?.getTime() ?? 0) - (toDateSafe(b.ranAt)?.getTime() ?? 0)
  );

  // What the agent brought into being for this item, whenever its run logged it.
  const agentPartners = new Set<string>();
  const agentFiles = new Set<string>();
  let itemFoundByAgent = false;
  for (const entry of log) {
    if (AGENT_RUN_TYPES.has(entry.type)) {
      if (entry.forPartnerId) agentPartners.add(entry.forPartnerId);
      if (entry.fileId) agentFiles.add(entry.fileId);
    }
    if (entry.type === "file_created" && (entry.summary ?? "").includes(FOUND_BY_AGENT)) itemFoundByAgent = true;
  }

  let credit = null as { method: AutomationMethod; partnerId?: string } | null;
  for (const entry of log) {
    if (!types.has(entry.type)) continue;
    if (ladder !== "connection" && isMerge(entry)) {
      if (credit && entry.forPartnerId) credit = { method: credit.method, partnerId: entry.forPartnerId };
      continue;
    }
    // A queue marker is not a run: the run logs itself when it ends.
    if (entry.status === "pending" || entry.type === "company_check") continue;
    const method = automationMethodOf(entry, ladder);
    counts[method] = (counts[method] ?? 0) + 1;

    if (entry.type === "partner_removed") {
      credit = null;
      continue;
    }
    if (!MATCH_TYPES.has(entry.type) || entry.status === "failed") continue;
    // A person confirming the Partner already there: the finder keeps the credit.
    if (ladder !== "connection" && method === "manual" && credit && entry.forPartnerId === credit.partnerId) continue;

    let creditMethod = method;
    if (ladder !== "connection" && entry.forPartnerId && agentPartners.has(entry.forPartnerId)) creditMethod = "magic";
    if (ladder === "connection" && method !== "manual") {
      if ((entry.fileId && agentFiles.has(entry.fileId)) || itemFoundByAgent) creditMethod = "magic";
    }
    credit = { method: creditMethod, partnerId: entry.forPartnerId ?? undefined };
  }

  return { methods, counts, matchedBy: matched && credit ? credit.method : null };
}
