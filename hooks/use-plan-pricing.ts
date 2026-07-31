"use client";

import { useEffect, useState } from "react";
import { callFunction } from "@/lib/firebase/callable";
import { PLANS, type PlanId } from "@/types/billing";

/**
 * Plan prices as Stripe reports them.
 *
 * The number shown to a user must be the number their card is charged, and Stripe is
 * what charges it. Reading it from Stripe removes the drift that existed while the
 * same figures lived in the backend config, a hand-maintained duplicate in
 * types/billing.ts, and inline literals in the comparison component — four values
 * that could disagree, with the on-screen one never being the billed one.
 *
 * `PLANS` is still the source for everything that is not money: names, features,
 * limits, ordering.
 *
 * Falls back to the local constants if the callable fails, but reports `source` so
 * the UI can mark the figure as indicative rather than presenting an unverified
 * number as fact.
 */

export interface PeriodPrice {
  amountMinor: number;
  currency: string;
  priceId: string;
}

export interface PlanPricing {
  monthly: PeriodPrice | null;
  yearly: PeriodPrice | null;
}

export interface PlanPricingState {
  plans: Partial<Record<PlanId, PlanPricing>>;
  /** Where the numbers came from. "config" means unverified against Stripe. */
  source: "stripe" | "cache" | "config" | "loading";
  mode: "test" | "live" | null;
  /** Addons with no Stripe price object — see below. */
  unpricedAddons: string[];
}

/** Minor units to a display string, without float arithmetic on money. */
export function formatMinor(price: PeriodPrice | null | undefined): string | null {
  if (!price) return null;
  const major = price.amountMinor / 100;
  // Whole amounts read better without ",00" on a pricing card.
  const body = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return `${body} ${price.currency}`;
}

const LOCAL_FALLBACK: Partial<Record<PlanId, PlanPricing>> = Object.fromEntries(
  (Object.keys(PLANS) as PlanId[]).map((id) => {
    const eur = PLANS[id].monthlyPriceEur;
    return [
      id,
      {
        monthly:
          typeof eur === "number"
            ? { amountMinor: Math.round(eur * 100), currency: "EUR", priceId: "" }
            : null,
        yearly: null,
      },
    ];
  }),
);

export function usePlanPricing(): PlanPricingState {
  const [state, setState] = useState<PlanPricingState>({
    plans: LOCAL_FALLBACK,
    source: "loading",
    mode: null,
    unpricedAddons: [],
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = (await callFunction("getPlanPricing", {})) as {
          plans: Partial<Record<PlanId, PlanPricing>>;
          source: "stripe" | "cache" | "config";
          mode: "test" | "live";
          unpricedAddons: string[];
        };
        if (cancelled) return;
        setState({
          plans: res.plans,
          source: res.source,
          mode: res.mode,
          unpricedAddons: res.unpricedAddons ?? [],
        });
      } catch {
        if (cancelled) return;
        // Never leave a pricing page blank; show the local figures and say so.
        setState({
          plans: LOCAL_FALLBACK,
          source: "config",
          mode: null,
          unpricedAddons: [],
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
