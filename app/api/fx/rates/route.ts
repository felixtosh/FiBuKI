export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { loadEcbRateTable } from "@/functions/src/fx/ecbRateStore";
import type { EcbDay } from "@/functions/src/fx/ecbRates";

/**
 * GET /api/fx/rates?start=YYYY-MM-DD&end=YYYY-MM-DD&currencies=USD,CHF
 *
 * The display side's window onto the ECB reference rates (#120). It replaces
 * the hardcoded EUR_RATES table that `lib/currency/converter.ts` carried: a
 * hand-kept list of monthly averages that stopped at January 2025 and had no
 * way to learn a newer month, because a cron cannot rewrite a committed
 * constant.
 *
 * Why a route rather than a client read: `fxReferenceRates` is denied to the
 * client in `firestore.rules` and in the self-host data policy, deliberately —
 * the client never touches the DB (`docs/rewrite-goals.md`). The Admin SDK read
 * happens here, and the same rows then serve display, matching and the UVA.
 *
 * An empty store is a 200 with no days, NOT an error. The store is filled by
 * `scheduledRefreshEcbRates`, so between a deploy of this route and the first
 * run of that job there is a window with nothing in it. Callers render their
 * existing conversion-failed state for a day they cannot price, which is the
 * same state they already show for any date the old table could not reach.
 */

/** Widest window one request may ask for. Bounds the response, not the store. */
const MAX_SPAN_DAYS = 3660;

/**
 * Ceiling on currencies per request, set at "whatever the ECB publishes" rather
 * than lower. A tighter cap would be a trap: the caller widens one shared
 * request as it meets more currencies, so a user holding documents in more
 * currencies than the cap would lose EVERY conversion at once, not just the
 * marginal one.
 */
const MAX_CURRENCIES = 40;

/**
 * The response is roughly `days x currencies` numbers, and neither dimension
 * alone bounds it: ten years of one currency and two years of thirty are both
 * fine, ten years of thirty is not. Budget the product.
 */
const MAX_DAY_CURRENCY_CELLS = 40_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
  );
}

/**
 * Keep only the currencies asked for, and drop a day left with none.
 *
 * `wanted` holds currency codes that came from the query string, so the keys
 * written here derive from a request. They are already narrowed to `^[A-Z]{3}$`
 * before this runs, which no dangerous key can pass — but that filter is three
 * call frames away and neither a reader nor CodeQL can see it from here
 * (js/remote-property-injection, alert #296). The null prototype settles it
 * locally and permanently: with no prototype, a key called "__proto__" is an
 * ordinary key and reaches nothing. The object is serialised straight into the
 * JSON response, so it needs no methods.
 */
function project(days: EcbDay[], wanted: Set<string>): EcbDay[] {
  const out: EcbDay[] = [];
  for (const day of days) {
    const rates: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const code of wanted) {
      const rate = day.rates[code];
      if (typeof rate === "number") rates[code] = rate;
    }
    if (Object.keys(rates).length > 0) out.push({ date: day.date, rates });
  }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    await getServerUserIdWithFallback(request);

    const params = request.nextUrl.searchParams;
    const start = params.get("start") ?? "";
    const end = params.get("end") ?? "";
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
      return NextResponse.json(
        { error: "start and end are required as YYYY-MM-DD" },
        { status: 400 }
      );
    }
    const span = daysBetween(start, end);
    if (Number.isNaN(span) || span < 0) {
      return NextResponse.json({ error: "end must not precede start" }, { status: 400 });
    }
    if (span > MAX_SPAN_DAYS) {
      return NextResponse.json(
        { error: `span exceeds ${MAX_SPAN_DAYS} days` },
        { status: 400 }
      );
    }

    // EUR is the quote unit and never appears in the feed, so it is not asked
    // for and not returned; a EUR leg is the constant 1.
    const wanted = new Set(
      (params.get("currencies") ?? "")
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{3}$/.test(c) && c !== "EUR")
    );
    if (wanted.size === 0) {
      return NextResponse.json(
        { error: "currencies is required (comma-separated ISO codes)" },
        { status: 400 }
      );
    }
    if (wanted.size > MAX_CURRENCIES) {
      return NextResponse.json(
        { error: `at most ${MAX_CURRENCIES} currencies per request` },
        { status: 400 }
      );
    }
    if ((span + 1) * wanted.size > MAX_DAY_CURRENCY_CELLS) {
      return NextResponse.json(
        { error: "window and currency count together exceed the response budget" },
        { status: 400 }
      );
    }

    // loadEcbRateTable widens the window by the lookback itself, so a payment
    // on the first day of `start` can still reach the rate published before it.
    const table = await loadEcbRateTable(getAdminDb(), start, end);

    return NextResponse.json({ days: project(table.days, wanted) });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] fx/rates error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
