/**
 * AI Budget Check Utility
 *
 * Single-read check to determine if a user can consume AI resources.
 * Priority chain: fair use -> credits -> overage -> denied.
 */

import { getFirestore } from "firebase-admin/firestore";
import { PLANS } from "./config";
import type { AIBudgetCheckResult, PlanId } from "./config";

export async function checkAIBudget(userId: string): Promise<AIBudgetCheckResult> {
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

  // Already paused
  if (sub.aiPaused) {
    return {
      allowed: false,
      source: "none",
      remainingEur: 0,
      paused: true,
    };
  }

  const fairUseLimit = sub.aiFairUseLimitEur as number;
  const currentUsage = sub.aiUsageCurrentPeriodEur as number;
  const credits = sub.aiCreditsEur as number;
  const overageCap = sub.aiOverageCapEur as number;
  const currentOverage = sub.aiOverageCurrentPeriodEur as number;
  const plan = (sub.plan || "free") as PlanId;
  const overageAllowed = PLANS[plan]?.overageAllowed ?? false;

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

  // 2. Prepaid credits remaining?
  if (credits > 0.001) {
    return {
      allowed: true,
      source: "credits",
      remainingEur: credits,
      paused: false,
    };
  }

  // 3. Overage cap has room?
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
