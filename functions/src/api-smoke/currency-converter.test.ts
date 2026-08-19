/**
 * The web-side currency table (fork #111).
 *
 * The table is a hardcoded monthly snapshot whose newest key is 2025-01. Its
 * lookup used to end in `Object.keys(EUR_RATES).sort().reverse()[0]`, so every
 * date from 2025-05 onward — that is, every current-year amount — was
 * converted at January 2025 rates and rendered exactly like a correct figure.
 * These tests pin the substitution window and the refusal past it.
 *
 * Covers repo-root lib/currency/converter.ts, so it runs under
 * vitest.api-smoke.config.ts ONLY (needs the root dependency tree).
 */

import { describe, it, expect } from "vitest";
import {
  convertCurrency,
  getLatestRateMonth,
  MAX_RATE_SUBSTITUTION_MONTHS,
} from "../../../lib/currency/converter";

const latest = getLatestRateMonth();
const [latestYear, latestMonth] = latest.split("-").map(Number);

/** A date `offset` months after the newest month in the table. */
function monthsAfterLatest(offset: number): Date {
  return new Date(Date.UTC(latestYear, latestMonth - 1 + offset, 15));
}

describe("convertCurrency", () => {
  it("uses the exact month when the table has it", () => {
    const result = convertCurrency(10000, "USD", "EUR", new Date("2024-06-15"));
    expect(result).not.toBeNull();
    expect(result!.rateDate).toBe("2024-06");
    expect(result!.amount).toBe(Math.round(10000 / 1.075));
  });

  it("borrows from an earlier month within the substitution window", () => {
    const borrowed = convertCurrency(10000, "USD", "EUR", monthsAfterLatest(MAX_RATE_SUBSTITUTION_MONTHS));
    expect(borrowed).not.toBeNull();
    // Reported as the month it actually came from, not the month asked for.
    expect(borrowed!.rateDate).toBe(latest);
  });

  it("refuses a date past the substitution window instead of pricing it off the newest row", () => {
    expect(convertCurrency(10000, "USD", "EUR", monthsAfterLatest(MAX_RATE_SUBSTITUTION_MONTHS + 1))).toBeNull();
    // The case that made this a bug rather than a rounding question: a date
    // well past the end of the table, which is every amount dated after the
    // snapshot was taken.
    expect(convertCurrency(10000, "USD", "EUR", monthsAfterLatest(19))).toBeNull();
  });

  it("refuses a date before the table starts", () => {
    expect(convertCurrency(10000, "USD", "EUR", new Date("2019-03-15"))).toBeNull();
  });

  it("refuses a currency the table does not cover", () => {
    expect(convertCurrency(10000, "SEK", "EUR", new Date("2024-06-15"))).toBeNull();
    expect(convertCurrency(10000, "EUR", "SEK", new Date("2024-06-15"))).toBeNull();
  });

  it("converts a same-currency pair without consulting the table", () => {
    const result = convertCurrency(10000, "usd", "USD", monthsAfterLatest(19));
    expect(result).toMatchObject({ amount: 10000, currency: "USD", rate: 1, rateDate: "n/a" });
  });

  it("crosses two foreign currencies via EUR", () => {
    const result = convertCurrency(10000, "USD", "GBP", new Date("2024-06-15"));
    expect(result).not.toBeNull();
    expect(result!.rate).toBeCloseTo(0.8455 / 1.075, 6);
  });
});
