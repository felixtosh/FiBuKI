/**
 * GET /api/fx/rates — the display side's read of the ECB reference rates (#120).
 *
 * This route is what replaces the hardcoded `EUR_RATES` table: the rates now
 * live in `fxReferenceRates`, filled by `scheduledRefreshEcbRates`, and the
 * client reaches them through here because `fxReferenceRates` is denied to the
 * client in both firestore.rules and the self-host data policy.
 *
 * The case that earns its own test is the EMPTY store. `scheduledRefreshEcbRates`
 * is not deployed yet, and Cloud Functions do not auto-deploy from main, so the
 * store is empty in production the moment this route ships. An empty store must
 * answer 200 with no days — never a 500, never a zero rate — so the components
 * render the conversion-failed state they already show for an unpriceable date.
 *
 * Covers repo-root app/api/fx/rates/route.ts, so it runs under
 * vitest.api-smoke.config.ts ONLY (needs the root dependency tree).
 */

import { describe, it, expect } from "vitest";
import { setupRouteHarness } from "./route-harness";

const { store, authed } = setupRouteHarness();

const URL_BASE = "http://localhost/api/fx/rates";

async function get(query: string, uid = "user-1") {
  const { GET } = await import("@/app/api/fx/rates/route");
  return GET(authed(uid, `${URL_BASE}?${query}`, "GET"));
}

/** One month document in the shape `storeEcbDays` writes. */
function seedMonth(month: string, days: Record<string, Record<string, number>>) {
  store.seed("fxReferenceRates", month, { month, source: "ecb-eurofxref", days });
}

describe("GET /api/fx/rates", () => {
  it("answers 200 with no days when the store is empty", async () => {
    const res = await get("start=2026-08-01&end=2026-08-31&currencies=USD");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ days: [] });
  });

  it("returns the publication days in the window, for the asked-for currencies", async () => {
    seedMonth("2026-08", {
      "2026-08-03": { USD: 1.16, CHF: 0.94, JPY: 171.2 },
      "2026-08-04": { USD: 1.17, CHF: 0.95, JPY: 171.9 },
    });

    const res = await get("start=2026-08-01&end=2026-08-31&currencies=USD,CHF");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ date: string; rates: Record<string, number> }> };

    expect(body.days.map((d) => d.date)).toEqual(["2026-08-03", "2026-08-04"]);
    // JPY was not asked for, so it is not paid for.
    expect(body.days[0].rates).toEqual({ USD: 1.16, CHF: 0.94 });
  });

  it("reaches back past the start for the last rate published before it", async () => {
    // The ECB does not publish every day. A payment on 1 September is priced at
    // the last August publication, so the route must return it even though it
    // falls outside the requested window.
    seedMonth("2026-08", { "2026-08-31": { USD: 1.18 } });

    const res = await get("start=2026-09-01&end=2026-09-30&currencies=USD");
    const body = (await res.json()) as { days: Array<{ date: string }> };
    expect(body.days.map((d) => d.date)).toEqual(["2026-08-31"]);
  });

  it("rejects a request with no currencies rather than serving the whole feed", async () => {
    const res = await get("start=2026-08-01&end=2026-08-31");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed date", async () => {
    const res = await get("start=August&end=2026-08-31&currencies=USD");
    expect(res.status).toBe(400);
  });

  it("rejects a window wider than the cap", async () => {
    const res = await get("start=2000-01-01&end=2026-08-31&currencies=USD");
    expect(res.status).toBe(400);
  });

  it("accepts more currencies than the old table's four", async () => {
    // The cap is set at what the ECB publishes, not lower. A tighter one would
    // be a trap: the caller widens ONE shared request as it meets more
    // currencies, so a user holding documents in more currencies than the cap
    // would lose every conversion at once.
    const many = ["USD", "GBP", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "CAD", "AUD"];
    const res = await get(`start=2026-08-01&end=2026-08-31&currencies=${many.join(",")}`);
    expect(res.status).toBe(200);
  });

  it("rejects a window and currency count that together blow the response budget", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `C${i}`)
      .map((_, i) => ["USD", "GBP", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "CAD", "AUD", "NZD", "SGD", "HKD", "KRW", "MXN", "BRL", "ZAR", "TRY", "INR", "IDR", "ILS", "MYR", "PHP", "THB", "CNY", "RON", "BGN", "ISK"][i])
      .join(",");
    // Ten years is fine for one currency and fine for a few; not for thirty.
    const res = await get(`start=2016-09-01&end=2026-08-31&currencies=${many}`);
    expect(res.status).toBe(400);
  });

  it("requires a signed-in caller", async () => {
    const { GET } = await import("@/app/api/fx/rates/route");
    const anonymous = new Request(`${URL_BASE}?start=2026-08-01&end=2026-08-31&currencies=USD`);
    const res = await GET(anonymous as never);
    expect(res.status).toBe(401);
  });
});
