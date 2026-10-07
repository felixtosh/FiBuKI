/**
 * The File's log line when its Transaction suggestions change (#752).
 *
 * Suggestions are rescored often (a Partner edit, a date edit, a backfill), so
 * a line is written only when the best suggestion changes: a new one on top,
 * or the last one gone. The same answer rescored writes nothing.
 */

import { activityEntry } from "../utils/activity";

interface SuggestionLike {
  transactionId: string;
  confidence?: number | null;
  preview?: { name?: string | null } | null;
}

function topOf(list: unknown): SuggestionLike | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const first = list[0] as SuggestionLike | undefined;
  return first && typeof first.transactionId === "string" ? first : undefined;
}

export function transactionSuggestionsActivity(
  before: unknown,
  after: SuggestionLike[],
  via: string
): Record<string, unknown> | null {
  const previous = topOf(before);
  const next = topOf(after);
  if (previous?.transactionId === next?.transactionId) return null;
  if (!next) {
    return activityEntry({
      type: "transaction_suggested",
      actor: "auto",
      summary: `No Transaction suggested any more (${via})`,
    });
  }
  const pct = next.confidence != null ? ` (${Math.round(next.confidence)}%)` : "";
  return activityEntry({
    type: "transaction_suggested",
    actor: "auto",
    transactionId: next.transactionId,
    transactionName: next.preview?.name || null,
    confidence: next.confidence ?? null,
    summary: `${previous ? "Best suggestion is now" : "Suggested"} Transaction "${next.preview?.name || next.transactionId}"${pct}, by ${via}`,
  });
}
