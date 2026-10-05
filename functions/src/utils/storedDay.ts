/**
 * Stored days (#673).
 *
 * A stored date is UTC midnight of the Vienna calendar day, so the day it
 * names is its UTC date part. The host-zone getters and setters (`getDate`,
 * `getFullYear`, `setDate`, the multi-argument `new Date(y, m, d)`) agree with
 * that only on a UTC host: west of UTC they read the day before, and in
 * Europe/Vienna `setDate` keeps the local wall time across a clock change and
 * lands an hour off midnight. Everything here works in UTC, so the answer is
 * the same whatever zone the host runs in. A guard test keeps the host-zone
 * calls out of `functions/src`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The day a stored date names, as `YYYY-MM-DD`. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The year of the day a stored date names. */
export function yearOf(date: Date): number {
  return date.getUTCFullYear();
}

/**
 * The stored date `days` days after the day `date` falls on (before, when
 * negative). Always UTC midnight, so no clock change can move it.
 */
export function addDays(date: Date, days: number): Date {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(midnight + days * DAY_MS);
}

/** The Vienna calendar day of an instant (default: now), as a stored date. */
export function viennaToday(now: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Vienna" }).format(now);
  return new Date(`${day}T00:00:00Z`);
}

/** The Vienna calendar year of an instant (default: now). */
export function viennaYear(now: Date = new Date()): number {
  return yearOf(viennaToday(now));
}
