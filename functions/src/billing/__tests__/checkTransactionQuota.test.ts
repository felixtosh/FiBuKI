/**
 * Tests for transaction quota check logic.
 */

import { describe, it, expect } from "vitest";
import { PLANS } from "../config";
import type { PlanId, TransactionQuotaResult } from "../config";

// ============================================================================
// Pure function extraction of quota logic for unit testing.
// ============================================================================

interface QuotaData {
  plan: PlanId;
  transactionCountCurrentMonth: number;
  transactionCountMonth: string; // "YYYY-MM"
}

function checkQuotaPure(
  sub: QuotaData | null,
  countToAdd: number,
  currentYearMonth: string
): TransactionQuotaResult {
  if (!sub) {
    const freePlan = PLANS.free;
    return {
      allowed: countToAdd <= freePlan.transactionLimit,
      currentCount: 0,
      limit: freePlan.transactionLimit,
      remainingSlots: freePlan.transactionLimit,
    };
  }

  const limit = PLANS[sub.plan]?.transactionLimit ?? PLANS.free.transactionLimit;
  let currentCount = sub.transactionCountCurrentMonth || 0;

  // Reset if we're in a new month
  if (sub.transactionCountMonth !== currentYearMonth) {
    currentCount = 0;
  }

  const remainingSlots = Math.max(0, limit - currentCount);

  return {
    allowed: countToAdd <= remainingSlots,
    currentCount,
    limit,
    remainingSlots,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("checkTransactionQuota logic", () => {
  const currentMonth = "2026-02";

  describe("no subscription doc", () => {
    it("should allow small imports on free tier", () => {
      const result = checkQuotaPure(null, 10, currentMonth);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(PLANS.free.transactionLimit);
      expect(result.remainingSlots).toBe(PLANS.free.transactionLimit);
    });

    it("should deny imports exceeding free tier limit", () => {
      const result = checkQuotaPure(null, 51, currentMonth);
      expect(result.allowed).toBe(false);
    });

    it("should allow exactly the free tier limit", () => {
      const result = checkQuotaPure(null, 50, currentMonth);
      expect(result.allowed).toBe(true);
    });
  });

  describe("existing subscription", () => {
    const starterLimit = PLANS.starter.transactionLimit; // 100

    it("should allow when under limit", () => {
      const half = Math.floor(starterLimit / 2);
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: half, transactionCountMonth: currentMonth },
        half,
        currentMonth
      );
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(half);
      expect(result.limit).toBe(starterLimit);
      expect(result.remainingSlots).toBe(starterLimit - half);
    });

    it("should deny when import would exceed limit", () => {
      const used = starterLimit - 20;
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: used, transactionCountMonth: currentMonth },
        30,
        currentMonth
      );
      expect(result.allowed).toBe(false);
      expect(result.remainingSlots).toBe(20);
    });

    it("should allow when exactly at remaining slots", () => {
      const used = starterLimit - 20;
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: used, transactionCountMonth: currentMonth },
        20,
        currentMonth
      );
      expect(result.allowed).toBe(true);
      expect(result.remainingSlots).toBe(20);
    });

    it("should deny when already at limit", () => {
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: starterLimit, transactionCountMonth: currentMonth },
        1,
        currentMonth
      );
      expect(result.allowed).toBe(false);
      expect(result.remainingSlots).toBe(0);
    });
  });

  describe("month reset", () => {
    it("should reset count when month changes", () => {
      const starterLimit = PLANS.starter.transactionLimit;
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: starterLimit, transactionCountMonth: "2026-01" },
        50,
        "2026-02"
      );
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.remainingSlots).toBe(starterLimit);
    });
  });

  describe("all plan tiers", () => {
    const planIds: PlanId[] = ["free", "starter", "business", "pro"];

    it("should have correct limits for each plan", () => {
      for (const planId of planIds) {
        const result = checkQuotaPure(
          { plan: planId, transactionCountCurrentMonth: 0, transactionCountMonth: currentMonth },
          1,
          currentMonth
        );
        expect(result.limit).toBe(PLANS[planId].transactionLimit);
        expect(result.remainingSlots).toBe(PLANS[planId].transactionLimit);
      }
    });

    it("should allow exactly the plan limit for each tier", () => {
      for (const planId of planIds) {
        const limit = PLANS[planId].transactionLimit;
        const result = checkQuotaPure(
          { plan: planId, transactionCountCurrentMonth: 0, transactionCountMonth: currentMonth },
          limit,
          currentMonth
        );
        expect(result.allowed).toBe(true);
      }
    });

    it("should deny one over the plan limit for each tier", () => {
      for (const planId of planIds) {
        const limit = PLANS[planId].transactionLimit;
        const result = checkQuotaPure(
          { plan: planId, transactionCountCurrentMonth: 0, transactionCountMonth: currentMonth },
          limit + 1,
          currentMonth
        );
        expect(result.allowed).toBe(false);
      }
    });
  });

  describe("edge cases", () => {
    const starterLimit = PLANS.starter.transactionLimit;

    it("should handle zero count to add", () => {
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: starterLimit, transactionCountMonth: currentMonth },
        0,
        currentMonth
      );
      expect(result.allowed).toBe(true);
    });

    it("should handle negative remaining slots gracefully", () => {
      // If somehow count exceeded limit (shouldn't happen but defensive)
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: starterLimit + 50, transactionCountMonth: currentMonth },
        1,
        currentMonth
      );
      expect(result.allowed).toBe(false);
      expect(result.remainingSlots).toBe(0);
    });

    it("should handle empty month string as stale data (triggers reset)", () => {
      const result = checkQuotaPure(
        { plan: "starter", transactionCountCurrentMonth: starterLimit, transactionCountMonth: "" },
        50,
        currentMonth
      );
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
    });
  });
});
