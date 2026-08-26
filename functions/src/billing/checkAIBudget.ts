/**
 * AI Budget Check Utility
 *
 * Single-read check to determine if a user can consume AI resources.
 * Priority chain: fair use -> overage -> denied.
 */

import { getFirestore } from "firebase-admin/firestore";
import { PLANS } from "./config";
import type { AIBudgetCheckResult, PlanId } from "./config";

export interface BudgetFields {
  plan: PlanId;
  fairUseLimit: number;
  currentUsage: number;
  overageCap: number;
  currentOverage: number;
  overageAllowed: boolean;
}

/**
 * Read the budget numbers off a subscription doc, falling back to the plan's
 * defaults for any field that is not a finite number.
 *
 * A subscription doc is not guaranteed to carry every budget field: it can be
 * created by an older code path, by an admin tool, or by hand on a self-host
 * instance (`{"plan":"pro","status":"active"}` and nothing else). Reading
 * `undefined` straight into the arithmetic gives `NaN`, and every comparison
 * against NaN is false — so `fairUseRemaining > 0.001` fails, the overage branch
 * fails, and the very first AI call flips `aiPaused: true`. From then on the
 * pause check short-circuits and the user's AI features are dead with nothing
 * in the UI to say why. Missing fields must read as "fresh row for this plan",
 * not as "over budget".
 */
export function resolveBudgetFields(sub: Record<string, unknown>): BudgetFields {
  const planId = (typeof sub.plan === "string" && sub.plan in PLANS ? sub.plan : "free") as PlanId;
  const plan = PLANS[planId];
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    plan: planId,
    fairUseLimit: num(sub.aiFairUseLimitEur, plan.aiFairUseLimitEur),
    currentUsage: num(sub.aiUsageCurrentPeriodEur, 0),
    overageCap: num(sub.aiOverageCapEur, 0),
    currentOverage: num(sub.aiOverageCurrentPeriodEur, 0),
    overageAllowed: plan.overageAllowed ?? false,
  };
}

export async function checkAIBudget(
  userId: string,
  isAdmin: boolean = false
): Promise<AIBudgetCheckResult> {
  if (isAdmin) {
    return { allowed: true, source: "fair_use", remainingEur: Infinity, paused: false };
  }

  const db = getFirestore();
  const subDoc = await db.collection("subscriptions").doc(userId).get();

  if (!subDoc.exists) {
    // No subscription doc = free tier with full budget available
    const freePlan = PLANS.free;
    return {
      allowed: true,
      source: "fair_use",
      remainingEur: freePlan.aiFairUseLimitEur,
      paused: false,
    };
  }

  const sub = subDoc.data()!;

  // Admin override: free_plan users have unlimited AI budget
  if (sub.adminOverride === "free_plan") {
    return { allowed: true, source: "fair_use", remainingEur: Infinity, paused: false };
  }

  // Already paused
  if (sub.aiPaused) {
    return {
      allowed: false,
      source: "none",
      remainingEur: 0,
      paused: true,
    };
  }

  const { fairUseLimit, currentUsage, overageCap, currentOverage, overageAllowed } =
    resolveBudgetFields(sub);

  // 1. Fair use remaining?
  const fairUseRemaining = fairUseLimit - currentUsage;
  if (fairUseRemaining > 0.001) {
    return {
      allowed: true,
      source: "fair_use",
      remainingEur: fairUseRemaining,
      paused: false,
    };
  }

  // 2. Overage cap has room?
  if (overageAllowed && overageCap > 0) {
    const overageRemaining = overageCap - currentOverage;
    if (overageRemaining > 0.001) {
      return {
        allowed: true,
        source: "overage",
        remainingEur: overageRemaining,
        paused: false,
      };
    }
  }

  // Nothing left
  return {
    allowed: false,
    source: "none",
    remainingEur: 0,
    paused: false,
  };
}
