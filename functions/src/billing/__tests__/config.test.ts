/**
 * Tests for billing configuration and PLANS consistency.
 */

import { describe, it, expect } from "vitest";
import {
  PLANS,
  USER_TOKEN_RATE_PER_100K_EUR,
  STRIPE_PRICE_IDS,
  getStripePrices,
  getStripeMode,
  createDefaultSubscriptionData,
} from "../config";
import type { PlanId } from "../config";

// Active tiers ranked by tier (lowest -> highest). Used for monotonic checks.
// Legacy tiers (starter, business) live alongside as migration aliases.
const ALL_PLANS: PlanId[] = ["free", "data", "smart", "pro"];
const LEGACY_PLANS: PlanId[] = ["starter", "business"];
const EVERY_PLAN: PlanId[] = [...ALL_PLANS, ...LEGACY_PLANS];

describe("PLANS config", () => {
  it("should define all 6 plan tiers (4 active + 2 legacy)", () => {
    expect(Object.keys(PLANS)).toHaveLength(6);
    for (const planId of EVERY_PLAN) {
      expect(PLANS[planId]).toBeDefined();
    }
  });

  it("should have increasing prices", () => {
    const prices = ALL_PLANS.map((id) => PLANS[id].monthlyPriceEur);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
  });

  it("should have increasing transaction limits", () => {
    const limits = ALL_PLANS.map((id) => PLANS[id].transactionLimit);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThan(limits[i - 1]);
    }
  });

  it("should have non-decreasing AI fair use limits across active tiers", () => {
    // free and data are both no-AI tiers (limit = 0). smart and pro add AI budget.
    const limits = ALL_PLANS.map((id) => PLANS[id].aiFairUseLimitEur);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
    }
    // Sanity: AI tiers (smart, pro) must have a real budget.
    expect(PLANS.smart.aiFairUseLimitEur).toBeGreaterThan(0);
    expect(PLANS.pro.aiFairUseLimitEur).toBeGreaterThan(PLANS.smart.aiFairUseLimitEur);
  });

  it("should have free plan at 0 price", () => {
    expect(PLANS.free.monthlyPriceEur).toBe(0);
  });

  it("should not allow overage on free plan", () => {
    expect(PLANS.free.overageAllowed).toBe(false);
  });

  it("should allow overage on AI-enabled paid plans", () => {
    // data is no-AI, no overage; smart/pro are AI-enabled with overage.
    expect(PLANS.smart.overageAllowed).toBe(true);
    expect(PLANS.pro.overageAllowed).toBe(true);
    // Legacy AI-enabled tiers stay overage-allowed for grandfathered users.
    expect(PLANS.starter.overageAllowed).toBe(true);
    expect(PLANS.business.overageAllowed).toBe(true);
  });

  it("should have non-empty features for all plans", () => {
    for (const planId of EVERY_PLAN) {
      expect(PLANS[planId].features.length).toBeGreaterThan(0);
    }
  });

  it("should have id matching the plan key", () => {
    for (const planId of EVERY_PLAN) {
      expect(PLANS[planId].id).toBe(planId);
    }
  });

  it("should have non-empty name for all plans", () => {
    for (const planId of EVERY_PLAN) {
      expect(PLANS[planId].name.length).toBeGreaterThan(0);
    }
  });
});

describe("USER_TOKEN_RATE_PER_100K_EUR", () => {
  it("should be a positive number", () => {
    expect(USER_TOKEN_RATE_PER_100K_EUR).toBeGreaterThan(0);
  });

  it("should be 0.35", () => {
    expect(USER_TOKEN_RATE_PER_100K_EUR).toBe(0.35);
  });
});

describe("STRIPE_PRICE_IDS (legacy export — points at test prices)", () => {
  it("should have entries for every plan key", () => {
    for (const planId of EVERY_PLAN) {
      expect(STRIPE_PRICE_IDS[planId]).toBeDefined();
      expect("monthly" in STRIPE_PRICE_IDS[planId]).toBe(true);
      expect("yearly" in STRIPE_PRICE_IDS[planId]).toBe(true);
    }
  });

  it("should have null prices for free plan", () => {
    expect(STRIPE_PRICE_IDS.free.monthly).toBeNull();
    expect(STRIPE_PRICE_IDS.free.yearly).toBeNull();
  });

  it("should have null prices for legacy plans (no new signups)", () => {
    for (const planId of LEGACY_PLANS) {
      expect(STRIPE_PRICE_IDS[planId].monthly).toBeNull();
      expect(STRIPE_PRICE_IDS[planId].yearly).toBeNull();
    }
  });

  it("should have real Stripe price IDs for active paid plans", () => {
    for (const planId of ["data", "smart", "pro"] as PlanId[]) {
      expect(STRIPE_PRICE_IDS[planId].monthly).toMatch(/^price_/);
      expect(STRIPE_PRICE_IDS[planId].yearly).toMatch(/^price_/);
    }
  });
});

describe("getStripePrices / getStripeMode", () => {
  it("should detect test mode from sk_test_ key", () => {
    expect(getStripeMode("sk_test_abc123")).toBe("test");
  });

  it("should detect live mode from sk_live_ key", () => {
    expect(getStripeMode("sk_live_abc123")).toBe("live");
  });

  it("should return test prices for test key", () => {
    const prices = getStripePrices("sk_test_abc123");
    // Active paid tiers have real price IDs in test mode.
    expect(prices.data.monthly).toMatch(/^price_/);
    expect(prices.smart.monthly).toMatch(/^price_/);
    expect(prices.pro.monthly).toMatch(/^price_/);
    // Free + legacy stay null.
    expect(prices.free.monthly).toBeNull();
    expect(prices.starter.monthly).toBeNull();
    expect(prices.business.monthly).toBeNull();
  });

  it("should return live prices for live key", () => {
    const prices = getStripePrices("sk_live_abc123");
    // Active paid tiers have real live price IDs.
    expect(prices.data.monthly).toMatch(/^price_/);
    expect(prices.smart.monthly).toMatch(/^price_/);
    expect(prices.pro.monthly).toMatch(/^price_/);
    // Free + legacy stay null in live too.
    expect(prices.free.monthly).toBeNull();
    expect(prices.starter.monthly).toBeNull();
    expect(prices.business.monthly).toBeNull();
  });
});

describe("createDefaultSubscriptionData", () => {
  it("should create a valid free subscription", () => {
    const data = createDefaultSubscriptionData("user123");
    expect(data.userId).toBe("user123");
    expect(data.plan).toBe("free");
    expect(data.billingPeriod).toBe("monthly");
    expect(data.stripeCustomerId).toBeNull();
    expect(data.stripeSubscriptionId).toBeNull();
    expect(data.stripeSubscriptionStatus).toBe("none");
  });

  it("should set correct AI limits from free plan", () => {
    const data = createDefaultSubscriptionData("user123");
    expect(data.aiFairUseLimitEur).toBe(PLANS.free.aiFairUseLimitEur);
    expect(data.aiUsageCurrentPeriodEur).toBe(0);
    expect(data.aiCreditsEur).toBe(0);
    expect(data.aiOverageCapEur).toBe(0);
    expect(data.aiOverageCurrentPeriodEur).toBe(0);
    expect(data.aiPaused).toBe(false);
  });

  it("should set correct warning flags", () => {
    const data = createDefaultSubscriptionData("user123");
    expect(data.aiWarning90Sent).toBe(false);
    expect(data.aiWarning100Sent).toBe(false);
  });

  it("should set correct transaction count", () => {
    const data = createDefaultSubscriptionData("user123");
    expect(data.transactionCountCurrentMonth).toBe(0);
    expect(data.transactionCountMonth).toMatch(/^\d{4}-\d{2}$/);
  });

  it("should set period end approximately 1 month in the future", () => {
    const data = createDefaultSubscriptionData("user123");
    const now = new Date();
    const periodEnd = data.currentPeriodEnd as Date;
    const diffMs = periodEnd.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // Should be roughly 28-31 days
    expect(diffDays).toBeGreaterThan(27);
    expect(diffDays).toBeLessThan(32);
  });

  it("should set cancelAtPeriodEnd to false", () => {
    const data = createDefaultSubscriptionData("user123");
    expect(data.cancelAtPeriodEnd).toBe(false);
  });
});
