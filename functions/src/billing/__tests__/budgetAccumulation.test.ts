/**
 * Tests for budget accumulation and warning threshold logic.
 *
 * Tests the decision logic for where to charge AI costs
 * and when to trigger warning emails.
 */

import { describe, it, expect } from "vitest";
import { PLANS, USER_TOKEN_RATE_PER_100K_EUR } from "../config";
import type { PlanId } from "../config";

// ============================================================================
// Pure function extraction of accumulation logic for unit testing.
// ============================================================================

interface SubState {
  aiFairUseLimitEur: number;
  aiUsageCurrentPeriodEur: number;
  aiCreditsEur: number;
  aiOverageCapEur: number;
  aiOverageCurrentPeriodEur: number;
  plan: PlanId;
  aiWarning90Sent: boolean;
  aiWarning100Sent: boolean;
  aiPaused: boolean;
}

type ChargeTarget = "fair_use" | "credits" | "overage" | "pause_overage_exhausted" | "pause_budget_exhausted";
type WarningAction = "send_90" | "send_100" | "none";

interface AccumulationResult {
  chargeTarget: ChargeTarget;
  warningAction: WarningAction;
  shouldPause: boolean;
}

function computeAccumulation(sub: SubState, costEur: number): AccumulationResult {
  const overageAllowed = PLANS[sub.plan]?.overageAllowed ?? false;
  const fairUseRemaining = sub.aiFairUseLimitEur - sub.aiUsageCurrentPeriodEur;

  let chargeTarget: ChargeTarget;
  let shouldPause = false;

  if (fairUseRemaining > 0.001) {
    chargeTarget = "fair_use";
  } else if (sub.aiCreditsEur > 0.001) {
    chargeTarget = "credits";
  } else if (overageAllowed && sub.aiOverageCapEur > 0) {
    const overageRemaining = sub.aiOverageCapEur - sub.aiOverageCurrentPeriodEur;
    if (overageRemaining > 0.001) {
      chargeTarget = "overage";
    } else {
      chargeTarget = "pause_overage_exhausted";
      shouldPause = true;
    }
  } else {
    chargeTarget = "pause_budget_exhausted";
    shouldPause = true;
  }

  // Warning thresholds
  const newUsage = sub.aiUsageCurrentPeriodEur + costEur;
  const usagePercent = sub.aiFairUseLimitEur > 0
    ? (newUsage / sub.aiFairUseLimitEur) * 100
    : 100;

  let warningAction: WarningAction = "none";
  if (usagePercent >= 100 && !sub.aiWarning100Sent) {
    warningAction = "send_100";
  } else if (usagePercent >= 90 && !sub.aiWarning90Sent) {
    warningAction = "send_90";
  }

  return { chargeTarget, warningAction, shouldPause };
}

function calculateUserCostEur(inputTokens: number, outputTokens: number): number {
  const totalTokens = inputTokens + outputTokens;
  return (totalTokens / 100_000) * USER_TOKEN_RATE_PER_100K_EUR;
}

// ============================================================================
// Tests
// ============================================================================

describe("budget accumulation logic", () => {
  const baseSub: SubState = {
    aiFairUseLimitEur: 3.0,
    aiUsageCurrentPeriodEur: 0,
    aiCreditsEur: 0,
    aiOverageCapEur: 0,
    aiOverageCurrentPeriodEur: 0,
    plan: "starter",
    aiWarning90Sent: false,
    aiWarning100Sent: false,
    aiPaused: false,
  };

  describe("charge target selection", () => {
    it("should charge to fair use when budget available", () => {
      const result = computeAccumulation({ ...baseSub, aiUsageCurrentPeriodEur: 1.0 }, 0.01);
      expect(result.chargeTarget).toBe("fair_use");
      expect(result.shouldPause).toBe(false);
    });

    it("should charge to credits when fair use exhausted", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 3.0, aiCreditsEur: 5.0 },
        0.01
      );
      expect(result.chargeTarget).toBe("credits");
      expect(result.shouldPause).toBe(false);
    });

    it("should charge to overage when fair use and credits exhausted", () => {
      const result = computeAccumulation(
        {
          ...baseSub,
          aiUsageCurrentPeriodEur: 3.0,
          aiCreditsEur: 0,
          aiOverageCapEur: 10.0,
          aiOverageCurrentPeriodEur: 2.0,
        },
        0.01
      );
      expect(result.chargeTarget).toBe("overage");
      expect(result.shouldPause).toBe(false);
    });

    it("should pause when overage cap exhausted", () => {
      const result = computeAccumulation(
        {
          ...baseSub,
          aiUsageCurrentPeriodEur: 3.0,
          aiCreditsEur: 0,
          aiOverageCapEur: 10.0,
          aiOverageCurrentPeriodEur: 10.0,
        },
        0.01
      );
      expect(result.chargeTarget).toBe("pause_overage_exhausted");
      expect(result.shouldPause).toBe(true);
    });

    it("should pause when no budget source available", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 3.0 },
        0.01
      );
      expect(result.chargeTarget).toBe("pause_budget_exhausted");
      expect(result.shouldPause).toBe(true);
    });

    it("should pause free plan with no credits or overage", () => {
      const result = computeAccumulation(
        {
          ...baseSub,
          plan: "free",
          aiFairUseLimitEur: 0.5,
          aiUsageCurrentPeriodEur: 0.5,
        },
        0.01
      );
      expect(result.shouldPause).toBe(true);
    });
  });

  describe("warning thresholds", () => {
    it("should send 90% warning at 90% usage", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 2.69 },
        0.02 // 2.69 + 0.02 = 2.71, which is 90.3% of 3.0
      );
      expect(result.warningAction).toBe("send_90");
    });

    it("should not send 90% warning if already sent", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 2.69, aiWarning90Sent: true },
        0.02
      );
      expect(result.warningAction).toBe("none");
    });

    it("should send 100% warning at 100% usage", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 2.99 },
        0.02 // 2.99 + 0.02 = 3.01, which is 100.3% of 3.0
      );
      expect(result.warningAction).toBe("send_100");
    });

    it("should not send 100% warning if already sent", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 2.99, aiWarning90Sent: true, aiWarning100Sent: true },
        0.02
      );
      expect(result.warningAction).toBe("none");
    });

    it("should prefer 100% warning over 90% warning", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 0 },
        3.0 // 0 + 3.0 = 100%
      );
      expect(result.warningAction).toBe("send_100");
    });

    it("should not send warnings for low usage", () => {
      const result = computeAccumulation(
        { ...baseSub, aiUsageCurrentPeriodEur: 0 },
        0.01
      );
      expect(result.warningAction).toBe("none");
    });

    it("should handle zero fair use limit (100% always)", () => {
      const result = computeAccumulation(
        { ...baseSub, aiFairUseLimitEur: 0, aiUsageCurrentPeriodEur: 0 },
        0.01
      );
      expect(result.warningAction).toBe("send_100");
    });
  });
});

describe("calculateUserCostEur", () => {
  it("should calculate cost correctly for 100k tokens", () => {
    const cost = calculateUserCostEur(50000, 50000);
    expect(cost).toBeCloseTo(0.35);
  });

  it("should calculate cost correctly for 1M tokens", () => {
    const cost = calculateUserCostEur(500000, 500000);
    expect(cost).toBeCloseTo(3.5);
  });

  it("should handle zero tokens", () => {
    const cost = calculateUserCostEur(0, 0);
    expect(cost).toBe(0);
  });

  it("should handle input-only tokens", () => {
    const cost = calculateUserCostEur(100000, 0);
    expect(cost).toBeCloseTo(0.35);
  });

  it("should handle output-only tokens", () => {
    const cost = calculateUserCostEur(0, 100000);
    expect(cost).toBeCloseTo(0.35);
  });

  it("should be proportional", () => {
    const cost1 = calculateUserCostEur(50000, 50000);
    const cost2 = calculateUserCostEur(100000, 100000);
    expect(cost2).toBeCloseTo(cost1 * 2);
  });
});
