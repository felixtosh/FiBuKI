/**
 * What the display side can convert, now that `lib/currency/converter.ts` is
 * gone (#121).
 *
 * This file used to pin the substitution window of that module's hardcoded
 * `EUR_RATES` table (fork #111, then #118). The module is deleted, but the
 * question it answered is still worth answering, and the answer has changed:
 *
 *   Which currency list wins?  →  Whatever the ECB publishes.
 *
 * Not the four the frontend table carried, and explicitly not the thirteen
 * anchors in `functions/src/fx/fxPlausibility.ts`. Those gate plausibility with
 * a 5% tight and 20% loose tolerance, deliberately wide enough to swallow card
 * FX markups and years of drift — right for "is this a believable pair?",
 * useless for "what is this receipt worth in EUR?". The last test here is the
 * guard that keeps them from quietly becoming a conversion source.
 *
 * Runs under vitest.api-smoke.config.ts ONLY (needs the root dependency tree).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { FX_REFERENCE_TO_EUR } from "../fx/fxPlausibility";

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/fetch-with-auth", () => ({
  fetchWithAuth,
  getAuthHeaders: async () => ({}),
}));

import { convertAtEcbRate, __resetEcbRateSource } from "@/lib/currency";

/** The four currencies the deleted EUR_RATES table carried. */
const OLD_TABLE_CURRENCIES = ["USD", "GBP", "CHF", "JPY"];

/** The last month that table knew about. */
const OLD_TABLE_LAST_MONTH = "2025-01";

function respondWith(days: Array<{ date: string; rates: Record<string, number> }>) {
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ days }) });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Convert once to trigger the load, settle, then convert for real. */
async function convert(amount: number, from: string, to: string, date: Date) {
  convertAtEcbRate(amount, from, to, date);
  await settle();
  return convertAtEcbRate(amount, from, to, date);
}

beforeEach(() => {
  __resetEcbRateSource();
  fetchWithAuth.mockReset();
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("display currency coverage", () => {
  it("converts a currency the old four-currency table never carried", async () => {
    expect(OLD_TABLE_CURRENCIES).not.toContain("SEK");
    respondWith([{ date: "2026-08-03", rates: { SEK: 11.2 } }]);

    const hit = await convert(10_000, "SEK", "EUR", new Date(2026, 7, 3));
    expect(hit?.amount).toBe(Math.round(10_000 / 11.2));
    expect(hit?.rateDate).toBe("2026-08-03");
  });

  it("converts a date long past the old table's last month", async () => {
    // The cliff #120 describes: with EUR_RATES the newest rate was 2025-01 and
    // the three-month window put the last convertible date in April 2025.
    expect(OLD_TABLE_LAST_MONTH < "2026-08").toBe(true);
    respondWith([{ date: "2026-08-03", rates: { USD: 1.16 } }]);

    const hit = await convert(10_000, "USD", "EUR", new Date(2026, 7, 3));
    expect(hit).not.toBeNull();
  });

  it("still converts the historical dates the old table covered", async () => {
    respondWith([{ date: "2022-06-15", rates: { USD: 1.05 } }]);

    const hit = await convert(10_000, "USD", "EUR", new Date(2022, 5, 15));
    expect(hit?.rateDate).toBe("2022-06-15");
  });

  it("returns null for a code the ECB does not publish, rather than guessing", async () => {
    respondWith([{ date: "2026-08-03", rates: { USD: 1.16 } }]);

    expect(await convert(10_000, "XBT", "EUR", new Date(2026, 7, 3))).toBeNull();
  });

  it("does not fall back to the plausibility anchors for a currency the day lacks", async () => {
    // CHF is one of the thirteen anchors. If those ever became a conversion
    // source, this would return a figure at 1.07 instead of nothing.
    expect(FX_REFERENCE_TO_EUR.CHF).toBeGreaterThan(0);
    respondWith([{ date: "2026-08-03", rates: { USD: 1.16 } }]);

    expect(await convert(10_000, "CHF", "EUR", new Date(2026, 7, 3))).toBeNull();
  });
});
