import type { AutomationHistoryEntry } from "../../types/transaction";
import { toDateSafe } from "../../functions/src/utils/toDateSafe";

/**
 * The automation summary under a Partner or a connections section: which
 * kinds of automation ran on this area of the item, how often, and which one
 * made the match that stands.
 *
 * Read from `automationHistory` and nothing else, so the row and the activity
 * log can never disagree: every count here is a set of lines in the log.
 */

/** Who did it, in the order the row shows them. */
export const AUTOMATION_KINDS = ["auto", "llm", "magic", "manual"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** The part of an item a row summarises. */
export type AutomationArea = "partner" | "connection";

const AREA_TYPES: Record<AutomationArea, ReadonlySet<string>> = {
  partner: new Set([
    "partner_assigned",
    "partner_removed",
    "partner_suggested",
    "partner_matching",
    "company_check",
  ]),
  connection: new Set([
    "file_connected",
    "file_disconnected",
    "transaction_connected",
    "transaction_disconnected",
    "transaction_suggested",
    "connection_confirmed",
    "file_matching",
    "receipt_search",
  ]),
};

/** The entries that set the match, as opposed to suggesting or removing one. */
const MATCH_TYPES = new Set(["partner_assigned", "file_connected", "transaction_connected"]);

/** Background runs that ask a model, without a person starting them. */
const LLM_TYPES = new Set(["receipt_search", "partner_matching", "company_check"]);

/**
 * Which kind one log entry belongs to.
 * - manual: a person (their own pick, or a suggestion they clicked)
 * - magic: the AI agent, started from the wand or the chat (`actor: ai`)
 * - llm: a model call the pipeline made on its own
 * - auto: the rule-based matcher
 */
export function automationKindOf(entry: Pick<AutomationHistoryEntry, "type" | "actor">): AutomationKind {
  if (entry.actor === "manual" || entry.actor === "suggestion") return "manual";
  if (entry.actor === "ai") return "magic";
  if (LLM_TYPES.has(entry.type)) return "llm";
  return "auto";
}

export interface AutomationSummary {
  counts: Record<AutomationKind, number>;
  /** The kind whose match stands, or null when nothing is matched. */
  matchedBy: AutomationKind | null;
  /** The entry that made the standing match. */
  matchEntry: AutomationHistoryEntry | null;
}

/**
 * Summarise one area of an item's log. `matched` is whether the item holds a
 * match right now (a Partner, a connection); without it no kind is green,
 * because a match that was later removed led to nothing.
 */
export function summarizeAutomations(
  entries: AutomationHistoryEntry[] | undefined,
  area: AutomationArea,
  matched: boolean
): AutomationSummary {
  const counts: Record<AutomationKind, number> = { auto: 0, llm: 0, magic: 0, manual: 0 };
  let matchEntry: AutomationHistoryEntry | null = null;
  let matchTime = -Infinity;
  const types = AREA_TYPES[area];

  for (const entry of entries ?? []) {
    if (!types.has(entry.type)) continue;
    counts[automationKindOf(entry)] += 1;
    if (!MATCH_TYPES.has(entry.type) || entry.status === "failed") continue;
    const time = toDateSafe(entry.ranAt)?.getTime() ?? 0;
    if (time >= matchTime) {
      matchTime = time;
      matchEntry = entry;
    }
  }

  if (!matched) return { counts, matchedBy: null, matchEntry: null };
  return { counts, matchedBy: matchEntry ? automationKindOf(matchEntry) : null, matchEntry };
}
