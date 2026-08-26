/**
 * Period-valid Austrian VAT rate set (spec R1) and period boundary math (§7).
 */

import type { UvaPeriod } from "./types";

/** BGBl I 37/2026: 4.9% on Anlage-3 staples applies from this day. */
const RATE_49_FROM = "2026-07-01";

/**
 * Every rate that is EVER an Austrian VAT rate, including the 19%
 * Jungholz/Mittelberg enclave rate (§10 Abs 4). Period validity is a
 * separate question (ratesValidOn); this is the vocabulary for override
 * validation and implied-rate snapping.
 */
export const KNOWN_AUSTRIAN_RATES = [0, 4.9, 10, 13, 19, 20];

/**
 * Austrian VAT rates valid on a given Vienna calendar day (YYYY-MM-DD).
 * 19% (Jungholz/Mittelberg, §10 Abs 4) is deliberately NOT in this set —
 * it is only accepted with an ATU supplier UID (handled in derivation).
 */
export function ratesValidOn(date: string): number[] {
  const rates = [0, 10, 13, 20];
  if (date >= RATE_49_FROM) rates.push(4.9);
  return rates;
}

/** Rate set in force at any point during the period (for report metadata). */
export function ratesValidInPeriod(period: UvaPeriod): number[] {
  return ratesValidOn(periodBoundaries(period).end);
}

/**
 * First and last calendar day of the period as Vienna calendar days.
 * Pure string math — no Date objects, so no browser/host timezone can
 * leak in (the §7 bug class).
 */
export function periodBoundaries(period: UvaPeriod): {
  start: string;
  end: string;
} {
  const { year, type } = period;
  const startMonth = type === "monthly" ? period.period : (period.period - 1) * 3 + 1;
  const endMonth = type === "monthly" ? period.period : period.period * 3;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(daysInMonth(year, endMonth))}`,
  };
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return lengths[month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
