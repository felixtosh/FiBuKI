/**
 * Tests for admin override logic across billing guards.
 *
 * Covers:
 * - free_plan override bypasses all limits
 * - plan_tester uses normal plan limits (switchable)
 * - Plan switching preserves/resets correct counters
 * - createDefaultSubscriptionData generates valid defaults
 */

import { describe, it, expect } from "vitest";
import { PLANS, createDefaultSubscriptionData } from "../config";
import type { PlanId, AdminOverride } from "../config";

// ============================================================================
// Pure function: simulate setUserOverride subscription data creation
// Mirrors the logic in userManagement.ts
// ============================================================================

function buildOverrideData(
  targetUid: string,
  override: AdminOverride,
  plan?: PlanId,
  existingDoc: boolean = false
) {
  if (override === "free_plan") {
    const base = existingDoc
      ? {}
      : createDefaultSubscriptionData(targetUid);
    return {
      ...base,
      plan: "smart" as const,
      stripeSubscriptionStatus: "active" as const,
      aiFairUseLimitEur: PLANS.smart.aiFairUseLimitEur,
      adminOverride: "free_plan" as const,
    };
  }

  if (override === "plan_tester") {
    const targetPlan = plan || "free";
    const planConfig = PLANS[targetPlan] || PLANS.free;
    const base = existingDoc
      ? {}
      : createDefaultSubscriptionData(targetUid);
    return {
      ...base,
      plan: targetPlan,
      stripeSubscriptionStatus: "active" as const,
      aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
      adminOverride: "plan_tester" as const,
    };
  }

  // Clear override
  return {
    plan: "free" as const,
    stripeSubscriptionStatus: "none" as const,
    aiFairUseLimitEur: PLANS.free.aiFairUseLimitEur,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    adminOverride: undefined,
  };
}

// ============================================================================
// Pure function: simulate switchTesterPlan update
// Mirrors the logic in userManagement.ts
// ============================================================================

interface TesterSubscription {
  plan: PlanId;
  adminOverride: AdminOverride;
  aiFairUseLimitEur: number;
  aiUsageCurrentPeriodEur: number;
  aiOverageCurrentPeriodEur: number;
  aiPaused: boolean;
  aiWarning90Sent: boolean;
  aiWarning100Sent: boolean;
  transactionCountCurrentMonth: number;
}

function switchTesterPlanPure(
  sub: TesterSubscription,
  newPlan: PlanId
): TesterSubscription | { error: string } {
  if (sub.adminOverride !== "plan_tester") {
    return { error: "Only plan testers can switch plans" };
  }

  if (!PLANS[newPlan]) {
    return { error: "Invalid plan" };
  }

  const planConfig = PLANS[newPlan];

  return {
    ...sub,
    plan: newPlan,
    aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
    // Reset AI counters only — preserve transaction count
    aiUsageCurrentPeriodEur: 0,
    aiOverageCurrentPeriodEur: 0,
    aiPaused: false,
    aiWarning90Sent: false,
    aiWarning100Sent: false,
    // transactionCountCurrentMonth is PRESERVED (not reset)
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("admin overrides", () => {
  describe("createDefaultSubscriptionData", () => {
    it("should create valid defaults for a new user", () => {
      const data = createDefaultSubscriptionData("user123");
      expect(data.userId).toBe("user123");
      expect(data.plan).toBe("free");
      expect(data.stripeSubscriptionStatus).toBe("none");
      expect(data.aiFairUseLimitEur).toBe(PLANS.free.aiFairUseLimitEur);
      expect(data.aiUsageCurrentPeriodEur).toBe(0);
      expect(data.aiCreditsEur).toBe(0);
      expect(data.aiOverageCapEur).toBe(0);
      expect(data.transactionCountCurrentMonth).toBe(0);
      expect(data.aiPaused).toBe(false);
    });

    it("should set period dates in the future", () => {
      const data = createDefaultSubscriptionData("user123");
      expect(data.currentPeriodEnd > data.currentPeriodStart).toBe(true);
    });

    it("should set transactionCountMonth to current YYYY-MM", () => {
      const data = createDefaultSubscriptionData("user123");
      const now = new Date();
      const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      expect(data.transactionCountMonth).toBe(expected);
    });
  });

  describe("setUserOverride: free_plan", () => {
    it("should set plan to smart with full AI budget", () => {
      const data = buildOverrideData("user1", "free_plan");
      expect(data.plan).toBe("smart");
      expect(data.stripeSubscriptionStatus).toBe("active");
      expect(data.aiFairUseLimitEur).toBe(PLANS.smart.aiFairUseLimitEur);
      expect(data.adminOverride).toBe("free_plan");
    });

    it("should include full defaults for new user (no existing doc)", () => {
      const data = buildOverrideData("user1", "free_plan", undefined, false);
      expect(data).toHaveProperty("userId", "user1");
      expect(data).toHaveProperty("aiCreditsEur", 0);
      expect(data).toHaveProperty("transactionCountCurrentMonth", 0);
    });

    it("should only set override fields for existing doc", () => {
      const data = buildOverrideData("user1", "free_plan", undefined, true);
      expect(data).not.toHaveProperty("userId");
      expect(data).not.toHaveProperty("aiCreditsEur");
      expect(data.adminOverride).toBe("free_plan");
    });
  });

  describe("setUserOverride: plan_tester", () => {
    it("should default to free plan when no plan specified", () => {
      const data = buildOverrideData("user1", "plan_tester");
      expect(data.plan).toBe("free");
      expect(data.aiFairUseLimitEur).toBe(PLANS.free.aiFairUseLimitEur);
      expect(data.adminOverride).toBe("plan_tester");
    });

    it("should use specified plan", () => {
      const data = buildOverrideData("user1", "plan_tester", "business");
      expect(data.plan).toBe("business");
      expect(data.aiFairUseLimitEur).toBe(PLANS.business.aiFairUseLimitEur);
    });

    it("should set active subscription status", () => {
      const data = buildOverrideData("user1", "plan_tester", "starter");
      expect(data.stripeSubscriptionStatus).toBe("active");
    });
  });

  describe("setUserOverride: clear (null)", () => {
    it("should reset to free plan with no override", () => {
      const data = buildOverrideData("user1", null);
      expect(data.plan).toBe("free");
      expect(data.stripeSubscriptionStatus).toBe("none");
      expect(data.aiFairUseLimitEur).toBe(PLANS.free.aiFairUseLimitEur);
      expect(data.stripeCustomerId).toBeNull();
      expect(data.stripeSubscriptionId).toBeNull();
      expect(data.adminOverride).toBeUndefined();
    });
  });
});

describe("switchTesterPlan", () => {
  const baseTester: TesterSubscription = {
    plan: "free",
    adminOverride: "plan_tester",
    aiFairUseLimitEur: PLANS.free.aiFairUseLimitEur,
    aiUsageCurrentPeriodEur: 0.3,
    aiOverageCurrentPeriodEur: 0,
    aiPaused: false,
    aiWarning90Sent: false,
    aiWarning100Sent: false,
    transactionCountCurrentMonth: 42,
  };

  it("should switch to requested plan", () => {
    const result = switchTesterPlanPure(baseTester, "business");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.plan).toBe("business");
      expect(result.aiFairUseLimitEur).toBe(PLANS.business.aiFairUseLimitEur);
    }
  });

  it("should reset AI counters on plan switch", () => {
    const sub = { ...baseTester, aiUsageCurrentPeriodEur: 2.5, aiWarning90Sent: true };
    const result = switchTesterPlanPure(sub, "pro");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.aiUsageCurrentPeriodEur).toBe(0);
      expect(result.aiOverageCurrentPeriodEur).toBe(0);
      expect(result.aiPaused).toBe(false);
      expect(result.aiWarning90Sent).toBe(false);
      expect(result.aiWarning100Sent).toBe(false);
    }
  });

  it("should PRESERVE transaction count (graceful downgrade)", () => {
    const sub = { ...baseTester, plan: "pro" as PlanId, transactionCountCurrentMonth: 150 };
    const result = switchTesterPlanPure(sub, "free");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.transactionCountCurrentMonth).toBe(150);
    }
  });

  it("should reject non-tester users", () => {
    const nonTester = { ...baseTester, adminOverride: null as AdminOverride };
    const result = switchTesterPlanPure(nonTester, "pro");
    expect("error" in result).toBe(true);
  });

  it("should reject free_plan override users", () => {
    const freePlanUser = { ...baseTester, adminOverride: "free_plan" as AdminOverride };
    const result = switchTesterPlanPure(freePlanUser, "starter");
    expect("error" in result).toBe(true);
  });

  it("should allow switching to all valid plans", () => {
    const planIds: PlanId[] = ["free", "starter", "business", "pro"];
    for (const planId of planIds) {
      const result = switchTesterPlanPure(baseTester, planId);
      expect("error" in result).toBe(false);
      if (!("error" in result)) {
        expect(result.plan).toBe(planId);
        expect(result.aiFairUseLimitEur).toBe(PLANS[planId].aiFairUseLimitEur);
      }
    }
  });

  it("should un-pause AI on plan switch", () => {
    const paused = { ...baseTester, aiPaused: true };
    const result = switchTesterPlanPure(paused, "starter");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.aiPaused).toBe(false);
    }
  });
});

describe("plan-specific limits for testers", () => {
  it("free tester should have 50 tx limit and 0 EUR AI budget", () => {
    expect(PLANS.free.transactionLimit).toBe(50);
    expect(PLANS.free.aiFairUseLimitEur).toBe(0);
    expect(PLANS.free.overageAllowed).toBe(false);
  });

  it("starter tester should have 100 tx limit and 3.00 EUR AI budget", () => {
    expect(PLANS.starter.transactionLimit).toBe(100);
    expect(PLANS.starter.aiFairUseLimitEur).toBe(3.0);
    expect(PLANS.starter.overageAllowed).toBe(true);
  });

  it("business tester should have 200 tx limit and 8.00 EUR AI budget", () => {
    expect(PLANS.business.transactionLimit).toBe(200);
    expect(PLANS.business.aiFairUseLimitEur).toBe(8.0);
  });

  it("pro tester should have 1000 tx limit and 20.00 EUR AI budget", () => {
    expect(PLANS.pro.transactionLimit).toBe(1000);
    expect(PLANS.pro.aiFairUseLimitEur).toBe(20.0);
  });
});
