/**
 * Plan pricing, read from Stripe.
 *
 * ## Why Stripe rather than a local constant
 *
 * The price a user is shown must be the price their card is charged, and Stripe is
 * what charges it. Before this, the same numbers lived in THREE places — the backend
 * PLANS config, a hand-maintained duplicate in types/billing.ts (forced by
 * functions/tsconfig.json pinning rootDir to "src"), and inline literals in
 * billing-plan-comparison.tsx — none of which were checked against Stripe. Four
 * numbers that could disagree, and the one on screen was never the one that billed.
 *
 * Now the price objects Stripe already holds are the single source of truth, so
 * editing a price in the Stripe dashboard is what changes the displayed price, and
 * drift is not merely unlikely but unrepresentable.
 *
 * PLANS keeps everything that is NOT money: features, limits, ordering, copy.
 *
 * ## Caching
 *
 * Prices change rarely and the pricing page is hot, so results are cached in
 * `config/pricing` and reused for CACHE_TTL_MS. A Stripe outage therefore degrades
 * to a slightly stale price rather than a blank page, and falls back to the config
 * constants only if there is no cache at all — a wrong-but-plausible number beats
 * an empty one on a page whose whole job is to state a price.
 *
 * ## Addons are deliberately absent
 *
 * bmdExport / investments / prioritySupport are flag-only: their activation
 * callables carry "TODO: integrate Stripe subscription item for billing" and make no
 * Stripe calls at all, so no price object exists to read. Returning a price for them
 * here would reproduce the bug this replaces — the UI currently shows
 * "+ Priority Support: 50 EUR" for something that bills nothing. They are reported
 * as unpriced so the caller can decide what to render, rather than inventing a
 * number.
 */

import Stripe from "stripe";
import { defineSecret } from "firebase-functions/params";
import { createCallable } from "../utils/createCallable";
import { getStripePrices, PLANS, type PlanId } from "./config";
import { Timestamp } from "firebase-admin/firestore";

const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");

/** Long enough that the pricing page never waits on Stripe; short enough that a
 *  dashboard price change is live within the hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface PeriodPrice {
  /** Minor units, exactly as Stripe reports them — never a float. */
  amountMinor: number;
  currency: string;
  /** The Stripe price object this came from, for support and debugging. */
  priceId: string;
}

export interface PlanPricing {
  monthly: PeriodPrice | null;
  yearly: PeriodPrice | null;
}

export interface PlanPricingResponse {
  plans: Partial<Record<PlanId, PlanPricing>>;
  /** "stripe" | "cache" | "config" — so the client can tell how trustworthy it is. */
  source: "stripe" | "cache" | "config";
  /** Stripe mode the prices belong to, surfaced so a test-mode deployment is obvious. */
  mode: "test" | "live";
  /**
   * Addons with no Stripe price object. Present so the UI stops asserting a charge
   * that does not happen; see the module note.
   */
  unpricedAddons: string[];
}

const UNPRICED_ADDONS = ["bmdExport", "investments", "prioritySupport"];

/** Money straight from Stripe: no rounding, no float arithmetic, no local copy. */
function toPeriodPrice(price: Stripe.Price): PeriodPrice | null {
  if (price.unit_amount === null) return null;
  return {
    amountMinor: price.unit_amount,
    currency: price.currency.toUpperCase(),
    priceId: price.id,
  };
}

export const getPlanPricingCallable = createCallable<
  Record<string, never>,
  PlanPricingResponse
>(
  { name: "getPlanPricing", secrets: [stripeSecretKey] },
  async (ctx) => {
    const cacheRef = ctx.db.collection("config").doc("pricing");
    const secret = stripeSecretKey.value().trim();
    const mode: "test" | "live" = secret.startsWith("sk_test_") ? "test" : "live";

    // Serve the cache when fresh AND from the same Stripe mode — a cached live
    // price must never be shown by a test-mode deployment or vice versa.
    const cached = await cacheRef.get();
    if (cached.exists) {
      const d = cached.data()!;
      const at = (d.fetchedAt as Timestamp | undefined)?.toMillis() ?? 0;
      if (d.mode === mode && Date.now() - at < CACHE_TTL_MS) {
        return {
          plans: d.plans as Partial<Record<PlanId, PlanPricing>>,
          source: "cache",
          mode,
          unpricedAddons: UNPRICED_ADDONS,
        };
      }
    }

    const priceMap = getStripePrices(secret);
    const wanted: Array<{ plan: PlanId; period: "monthly" | "yearly"; id: string }> = [];
    for (const plan of Object.keys(priceMap) as PlanId[]) {
      for (const period of ["monthly", "yearly"] as const) {
        const id = priceMap[plan][period];
        if (id) wanted.push({ plan, period, id });
      }
    }

    try {
      const stripe = new Stripe(secret);
      const fetched = await Promise.all(
        wanted.map(async (w) => ({ ...w, price: await stripe.prices.retrieve(w.id) })),
      );

      const plans: Partial<Record<PlanId, PlanPricing>> = {};
      for (const f of fetched) {
        const entry = (plans[f.plan] ??= { monthly: null, yearly: null });
        entry[f.period] = toPeriodPrice(f.price);
      }

      // Best-effort cache write: failing to cache must not fail the request.
      await cacheRef
        .set({ plans, mode, fetchedAt: Timestamp.now() }, { merge: false })
        .catch(() => undefined);

      return { plans, source: "stripe", mode, unpricedAddons: UNPRICED_ADDONS };
    } catch (err) {
      console.error(
        "[getPlanPricing] Stripe unavailable, falling back:",
        err instanceof Error ? err.message : String(err),
      );

      // Prefer a stale cache over config constants: it at least came from Stripe once.
      if (cached.exists) {
        const d = cached.data()!;
        if (d.mode === mode) {
          return {
            plans: d.plans as Partial<Record<PlanId, PlanPricing>>,
            source: "cache",
            mode,
            unpricedAddons: UNPRICED_ADDONS,
          };
        }
      }

      // Last resort. Explicitly labelled so the client can say the price is
      // indicative rather than presenting an unverified number as fact.
      const plans: Partial<Record<PlanId, PlanPricing>> = {};
      for (const plan of Object.keys(PLANS) as PlanId[]) {
        const eur = PLANS[plan].monthlyPriceEur;
        plans[plan] = {
          monthly:
            typeof eur === "number"
              ? { amountMinor: Math.round(eur * 100), currency: "EUR", priceId: "" }
              : null,
          yearly: null,
        };
      }
      return { plans, source: "config", mode, unpricedAddons: UNPRICED_ADDONS };
    }
  },
);
