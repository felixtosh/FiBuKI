/**
 * The display-side ECB rate cache (#120) — repo-root lib/currency/ecb-rate-source.ts.
 *
 * What these pin is the awkward part of replacing a bundled table with a
 * fetched one: the components convert INSIDE render and cannot await, so the
 * first call for an unseen day has to answer null, record the need, and load
 * once. Null is the conversion-failed state the components already handle; a
 * wrong number would not be.
 *
 * Runs under vitest.api-smoke.config.ts ONLY (needs the root dependency tree
 * for the `@/` alias).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/fetch-with-auth", () => ({
  fetchWithAuth,
  getAuthHeaders: async () => ({}),
}));

import {
  convertAtEcbRate,
  subscribeToEcbRates,
  __resetEcbRateSource,
} from "@/lib/currency/ecb-rate-source";

/** One ECB publication day, as the route serves it. */
const AUG_3 = { date: "2026-08-03", rates: { USD: 1.16, CHF: 0.94 } };

function respondWith(days: Array<{ date: string; rates: Record<string, number> }>) {
  fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => ({ days }),
  });
}

/** Let the queued flush run and its fetch settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  __resetEcbRateSource();
  fetchWithAuth.mockReset();
  // The module refuses to fetch during SSR; these tests are the browser case.
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("convertAtEcbRate", () => {
  it("answers null on the first call and converts once the rates arrive", async () => {
    respondWith([AUG_3]);

    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
    await settle();

    const hit = convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3));
    expect(hit).toEqual({
      amount: Math.round(10_000 / 1.16),
      currency: "EUR",
      rate: 1 / 1.16,
      rateDate: "2026-08-03",
    });
  });

  it("notifies subscribers when the table arrives, so the render repeats", async () => {
    respondWith([AUG_3]);
    const seen = vi.fn();
    subscribeToEcbRates(seen);

    convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3));
    await settle();

    expect(seen).toHaveBeenCalled();
  });

  it("keeps returning null against an empty store, and asks only once", async () => {
    // The state between deploying this and the first run of
    // scheduledRefreshEcbRates. It must not become a request loop.
    respondWith([]);

    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
    await settle();
    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
    await settle();
    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
    await settle();

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("never converts at a rate from an unrelated day", async () => {
    // A single August rate must not price a date months later. The lookback is
    // seven days; past that the answer is "we do not know", which is exactly
    // what the hardcoded table used to get wrong by returning its newest row.
    respondWith([AUG_3]);
    convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3));
    await settle();

    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 10, 15))).toBeNull();
  });

  it("prices a non-publication day at the last day published before it", async () => {
    respondWith([AUG_3]);
    convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3));
    await settle();

    // 2026-08-03 is a Monday; the Saturday after it has no publication.
    const hit = convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 8));
    expect(hit?.rateDate).toBe("2026-08-03");
  });

  it("needs no rates for a same-currency conversion", () => {
    const hit = convertAtEcbRate(10_000, "EUR", "EUR", new Date(2026, 7, 3));
    expect(hit).toEqual({ amount: 10_000, currency: "EUR", rate: 1, rateDate: "n/a" });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("crosses two currencies through the same publication day", async () => {
    respondWith([AUG_3]);
    convertAtEcbRate(10_000, "USD", "CHF", new Date(2026, 7, 3));
    await settle();

    const hit = convertAtEcbRate(10_000, "USD", "CHF", new Date(2026, 7, 3));
    expect(hit?.rate).toBeCloseTo(0.94 / 1.16, 10);
    expect(hit?.rateDate).toBe("2026-08-03");
  });

  it("widens the window when a further-back date is asked for", async () => {
    respondWith([AUG_3]);
    convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3));
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    respondWith([{ date: "2024-02-15", rates: { USD: 1.08 } }, AUG_3]);
    convertAtEcbRate(10_000, "USD", "EUR", new Date(2024, 1, 15));
    await settle();

    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    const url = String(fetchWithAuth.mock.calls[1][0]);
    expect(url).toContain("start=2024-02-15");
    expect(url).toContain("end=2026-08-03");
    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2024, 1, 15))?.rateDate).toBe("2024-02-15");
  });

  it("stops asking after a 4xx instead of one request per render", async () => {
    // A window the route refuses is not going to start working; re-asking would
    // be a request loop driven by the render loop.
    fetchWithAuth.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    for (let i = 0; i < 3; i++) {
      expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
      await settle();
    }
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("holds off after a 5xx rather than retrying on every render", async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    for (let i = 0; i < 3; i++) {
      expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
      await settle();
    }
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("holds off the same way when the fetch itself throws", async () => {
    fetchWithAuth.mockRejectedValue(new Error("offline"));

    for (let i = 0; i < 3; i++) {
      expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
      await settle();
    }
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("does not fetch during SSR", () => {
    vi.stubGlobal("window", undefined);
    expect(convertAtEcbRate(10_000, "USD", "EUR", new Date(2026, 7, 3))).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
