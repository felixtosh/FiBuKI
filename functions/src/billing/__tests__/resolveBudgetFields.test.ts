/**
 * A subscription doc missing its budget fields must read as a fresh row for
 * its plan — not as NaN, which every comparison treats as "over budget" and
 * which flipped `aiPaused: true` on the first AI call of a hand-seeded
 * self-host row (`{"plan":"pro","status":"active"}`).
 */

import { describe, it, expect } from "vitest";
import { PLANS } from "../config";
import { resolveBudgetFields } from "../checkAIBudget";

describe("resolveBudgetFields", () => {
  it("passes through a fully populated doc unchanged", () => {
    const r = resolveBudgetFields({
      plan: "smart",
      aiFairUseLimitEur: 8,
      aiUsageCurrentPeriodEur: 2.5,
      aiOverageCapEur: 10,
      aiOverageCurrentPeriodEur: 1,
    });
    expect(r).toEqual({
      plan: "smart",
      fairUseLimit: 8,
      currentUsage: 2.5,
      overageCap: 10,
      currentOverage: 1,
      overageAllowed: PLANS.smart.overageAllowed,
    });
  });

  it("falls back to the plan's fair-use limit and zero usage when fields are absent", () => {
    // The exact shape found on a live self-host instance.
    const r = resolveBudgetFields({ plan: "pro", status: "active" });
    expect(r.fairUseLimit).toBe(PLANS.pro.aiFairUseLimitEur);
    expect(r.currentUsage).toBe(0);
    expect(r.overageCap).toBe(0);
    expect(r.currentOverage).toBe(0);
    // And crucially: the numbers the callers subtract are finite, so
    // "fair use remaining" is a real, positive number rather than NaN.
    expect(r.fairUseLimit - r.currentUsage).toBeGreaterThan(0);
  });

  it("never yields NaN for garbage values either", () => {
    const r = resolveBudgetFields({
      plan: "pro",
      aiFairUseLimitEur: "20",
      aiUsageCurrentPeriodEur: null,
      aiOverageCapEur: NaN,
      aiOverageCurrentPeriodEur: undefined,
    });
    for (const v of [r.fairUseLimit, r.currentUsage, r.overageCap, r.currentOverage]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("treats an unknown or missing plan as free", () => {
    expect(resolveBudgetFields({}).plan).toBe("free");
    expect(resolveBudgetFields({ plan: "enterprise-ultra" }).plan).toBe("free");
    expect(resolveBudgetFields({}).fairUseLimit).toBe(PLANS.free.aiFairUseLimitEur);
  });
});
