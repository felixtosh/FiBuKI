/**
 * When a Remainder Match may connect itself (#242).
 *
 * #239 made a File that closes a Transaction's Remainder score as an amount
 * hit and left every such Match a suggestion. This module is the exception:
 * **same-day evidence**, guarded against stealing a File from a Transaction
 * that holds nothing. See
 * [ADR-0008](../../../docs/adr/0008-remainder-auto-connect-is-same-day-only.md).
 *
 * Dependency-free on purpose, like `coverage.ts`: the rule is decided from
 * dates and already-scored candidates, so it stays testable without the Admin
 * SDK and cannot quietly grow a query.
 */

/** Anything with a `toDate()`, which is what both a real and a fake Timestamp have. */
interface DateLike {
  toDate(): Date;
}

/**
 * The calendar day an extracted date names, as `YYYY-MM-DD`.
 *
 * Read in UTC, because that is where an extracted date is put: the Extraction
 * reads a printed day off a document and stores it as that day's midnight,
 * with no time of day to lose. Reading it back in the box's local zone would
 * make the same document same-day or not depending on where the container
 * runs.
 */
export function extractedDayKey(date: DateLike | null | undefined): string | null {
  if (!date || typeof date.toDate !== "function") return null;
  const d = date.toDate();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Do the candidate File and every File already on the Transaction carry the
 * same extracted day?
 *
 * Not the Transaction's booking date: a card payment books one to three days
 * after the receipt is printed, and requiring the bank's date would refuse the
 * honest cases this exists for.
 *
 * A missing extracted date — on the candidate or on any File already
 * connected — is not same-day. Unknown is not same-day.
 *
 * `connectedDates` is every File on the Transaction other than the candidate.
 * Empty means the Transaction holds nothing, which is not a Remainder case at
 * all; it answers false so a caller cannot reach the permission that way.
 */
export function isSameDayEvidence(
  candidateDate: DateLike | null | undefined,
  connectedDates: Array<DateLike | null | undefined>
): boolean {
  const candidateDay = extractedDayKey(candidateDate);
  if (!candidateDay) return false;
  if (connectedDates.length === 0) return false;
  return connectedDates.every((d) => extractedDayKey(d) === candidateDay);
}

/** The least a candidate has to be for the comparison below: an id and a score. */
interface ScoredCandidate {
  transactionId: string;
  confidence: number;
}

/**
 * Does some Transaction holding no Files want this File at least as much?
 *
 * The hazard same-day makes *more* likely, not less: two receipts from one
 * shop on one day and two card Transactions from that day. Scoring is per-File
 * and greedy, so receipt B can land on Transaction A's Remainder while its own
 * Transaction sits empty beside it. If any undocumented candidate in the same
 * run scores at or above the Remainder Match, the Remainder auto-connect is
 * skipped and stays a suggestion — receipt B lands on its own line, and if
 * that call was wrong the Remainder Match is still there to accept.
 *
 * Ties go to the empty Transaction ("at or above"): between a line that
 * explains nothing yet and one that is already half explained, the unexplained
 * line is the safer home.
 *
 * Every candidate was scored in this run already, so this is an in-memory
 * comparison, not another query.
 */
export function hasUndocumentedRival(
  match: ScoredCandidate,
  scored: ScoredCandidate[],
  holdsFiles: (transactionId: string) => boolean
): boolean {
  return scored.some(
    (other) =>
      other.transactionId !== match.transactionId &&
      other.confidence >= match.confidence &&
      !holdsFiles(other.transactionId)
  );
}
