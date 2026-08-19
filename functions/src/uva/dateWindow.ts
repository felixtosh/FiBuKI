/**
 * Date-window boundaries for YYYY-MM-DD filters (fork #65).
 *
 * Transaction dates are stored as UTC midnight of the Vienna calendar day, so
 * a window over calendar days is a pure-UTC comparison. Building the boundary
 * with a Vienna offset is wrong twice: it is only correct half the year (CET
 * vs CEST), and even in winter `+01:00` puts the from-boundary at 23:00 UTC of
 * the *previous* day, pulling the last day of the prior period into the window.
 *
 * Every caller that turns a calendar day into a Firestore range boundary goes
 * through here — see calculateUvaCallable and the MCP listTransactions handler.
 */

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * UTC midnight of the given Vienna calendar day, or null when the input is
 * not a real YYYY-MM-DD day. Callers treat null as "no boundary given".
 */
export function dayStartUtc(day: string): Date | null {
  if (!CALENDAR_DAY.test(day)) return null;

  const date = new Date(`${day}T00:00:00Z`);
  if (isNaN(date.getTime())) return null;

  // `new Date("2026-02-30T00:00:00Z")` is Invalid Date, but be explicit rather
  // than relying on that: a day that survives parsing must round-trip.
  if (date.toISOString().slice(0, 10) !== day) return null;

  return date;
}

/**
 * Exclusive upper bound for a window whose last day is `day` — UTC midnight of
 * the following day, so the end day itself is included. Null on a bad day.
 */
export function dayEndExclusiveUtc(day: string): Date | null {
  const start = dayStartUtc(day);
  if (!start) return null;

  return new Date(start.getTime() + DAY_MS);
}
