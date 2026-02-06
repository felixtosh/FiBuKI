/**
 * Tests for AI budget check logic.
 *
 * Tests the budget priority chain: fair use -> credits -> overage -> denied.
 * Uses a pure function extraction of the logic since the actual function
 * requires Firestore.
 */

import { describe, it, expect } from "vitest";
import { PLANS } from "../config";
import type { PlanId, AIBudgetCheckResult } from "../config";

// ============================================================================
// Pure function extraction of checkAIBudget logic for unit testing.
// This mirrors the logic in checkAIBudget.ts without Firestore dependency.
// ============================================================================

interface SubscriptionData {
  aiPaused: boolean;
  aiFairUseLimitEur: number;
  aiUsageCurrentPeriodEur: number;
  aiCreditsEur: number;
  aiOverageCapEur: number;
  aiOverageCurrentPeriodEur: number;
  plan: PlanId;
}

function checkBudgetPure(sub: SubscriptionData | null): AIBudgetCheckResult {
  if (!sub) {
    const freePlan = PLANS.free;
    return {
      allowed: true,
      source: "fair_use",
      remainingEur: freePlan.aiFairUseLimitEur,
      paused: false,
    };
  }

  if (sub.aiPaused) {
    return {
      allowed: false,
      source: "none",
      remainingEur: 0,
      paused: true,
    };
  }

  const fairUseRemaining = sub.aiFairUseLimitEur - sub.aiUsageCurrentPeriodEur;
  const overageAllowed = PLANS[sub.plan]?.overageAllowed ?? false;

  if (fairUseRemaining > 0.001) {
    return {
      allowed: true,
      source: "fair_use",
      remainingEur: fairUseRemaining,
      paused: false,
    };
  }

  if (sub.aiCreditsEur > 0.001) {
    return {
      allowed: true,
      source: "credits",
      remainingEur: sub.aiCreditsEur,
      paused: false,
    };
  }

  if (overageAllowed && sub.aiOverageCapEur > 0) {
    const overageRemaining = sub.aiOverageCapEur - sub.aiOverageCurrentPeriodEur;
    if (overageRemaining > 0.001) {
      return {
        allowed: true,
        source: "overage",
        remainingEur: overageRemaining,
        paused: false,
      };
    }
  }

  return {
    allowed: false,
    source: "none",
    remainingEur: 0,
    paused: false,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("checkAIBudget logic", () => {
  const baseSub: SubscriptionData = {
    aiPaused: false,
    aiFairUseLimitEur: 3.0,
    aiUsageCurrentPeriodEur: 0,
    aiCreditsEur: 0,
    aiOverageCapEur: 0,
    aiOverageCurrentPeriodEur: 0,
    plan: "starter",
  };

  describe("no subscription doc", () => {
    it("should allow with free tier fair use budget", () => {
      const result = checkBudgetPure(null);
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("fair_use");
      expect(result.remainingEur).toBe(PLANS.free.aiFairUseLimitEur);
      expect(result.paused).toBe(false);
    });
  });

  describe("already paused", () => {
    it("should deny when AI is paused", () => {
      const result = checkBudgetPure({ ...baseSub, aiPaused: true });
      expect(result.allowed).toBe(false);
      expect(result.source).toBe("none");
      expect(result.remainingEur).toBe(0);
      expect(result.paused).toBe(true);
    });
  });

  describe("fair use budget", () => {
    it("should allow when fair use has remaining budget", () => {
      const result = checkBudgetPure({ ...baseSub, aiUsageCurrentPeriodEur: 1.0 });
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("fair_use");
      expect(result.remainingEur).toBeCloseTo(2.0);
    });

    it("should allow when fair use is barely remaining", () => {
      const result = checkBudgetPure({ ...baseSub, aiUsageCurrentPeriodEur: 2.998 });
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("fair_use");
    });

    it("should not allow fair use when within epsilon of zero", () => {
      const result = checkBudgetPure({ ...baseSub, aiUsageCurrentPeriodEur: 2.9995 });
      expect(result.source).not.toBe("fair_use");
    });

    it("should not allow fair use when over limit", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 3.5,
        aiCreditsEur: 0,
        aiOverageCapEur: 0,
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("credits fallback", () => {
    it("should use credits when fair use is exhausted", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 3.0,
        aiCreditsEur: 5.0,
      });
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("credits");
      expect(result.remainingEur).toBeCloseTo(5.0);
    });

    it("should deny when credits are also exhausted (no overage)", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 3.0,
        aiCreditsEur: 0,
        aiOverageCapEur: 0,
      });
      expect(result.allowed).toBe(false);
      expect(result.source).toBe("none");
    });
  });

  describe("overage fallback", () => {
    it("should use overage when fair use and credits are exhausted", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 3.0,
        aiCreditsEur: 0,
        aiOverageCapEur: 10.0,
        aiOverageCurrentPeriodEur: 2.0,
      });
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("overage");
      expect(result.remainingEur).toBeCloseTo(8.0);
    });

    it("should deny when overage cap is also exhausted", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 3.0,
        aiCreditsEur: 0,
        aiOverageCapEur: 10.0,
        aiOverageCurrentPeriodEur: 10.0,
      });
      expect(result.allowed).toBe(false);
      expect(result.source).toBe("none");
    });

    it("should not allow overage on free plan", () => {
      const result = checkBudgetPure({
        ...baseSub,
        plan: "free",
        aiFairUseLimitEur: 0.5,
        aiUsageCurrentPeriodEur: 0.5,
        aiCreditsEur: 0,
        aiOverageCapEur: 10.0,
        aiOverageCurrentPeriodEur: 0,
      });
      expect(result.allowed).toBe(false);
      expect(result.source).toBe("none");
    });
  });

  describe("priority chain", () => {
    it("should prefer fair use over credits", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 1.0,
        aiCreditsEur: 10.0,
      });
      expect(result.source).toBe("fair_use");
    });

    it("should prefer credits over overage", () => {
      const result = checkBudgetPure({
        ...baseSub,
        aiUsageCurrentPeriodEur: 3.0,
        aiCreditsEur: 5.0,
        aiOverageCapEur: 10.0,
      });
      expect(result.source).toBe("credits");
    });
  });

  describe("all plan tiers", () => {
    it("should work for each plan with full budget", () => {
      const planIds: PlanId[] = ["free", "starter", "business", "pro"];
      for (const planId of planIds) {
        const result = checkBudgetPure({
          ...baseSub,
          plan: planId,
          aiFairUseLimitEur: PLANS[planId].aiFairUseLimitEur,
          aiUsageCurrentPeriodEur: 0,
        });
        expect(result.allowed).toBe(true);
        expect(result.source).toBe("fair_use");
        expect(result.remainingEur).toBe(PLANS[planId].aiFairUseLimitEur);
      }
    });
  });
});
