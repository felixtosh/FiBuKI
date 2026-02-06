/**
 * Tests to verify billing config consistency between frontend and backend.
 *
 * Since types are duplicated (rootDir constraint), this ensures
 * the server-side config stays internally consistent.
 */

import { describe, it, expect } from "vitest";
import { PLANS, USER_TOKEN_RATE_PER_100K_EUR, createDefaultSubscriptionData } from "../config";
import type { PlanId } from "../config";

describe("type consistency", () => {
  describe("PLANS invariants", () => {
    const planIds: PlanId[] = ["free", "starter", "business", "pro"];

    it("should have all required fields on every plan", () => {
      const requiredFields: (keyof typeof PLANS.free)[] = [
        "id",
        "name",
        "monthlyPriceEur",
        "transactionLimit",
        "aiFairUseLimitEur",
        "overageAllowed",
        "features",
      ];

      for (const planId of planIds) {
        for (const field of requiredFields) {
          expect(
            PLANS[planId][field],
            `${planId}.${field} should be defined`
          ).toBeDefined();
        }
      }
    });

    it("should have positive transaction limits", () => {
      for (const planId of planIds) {
        expect(PLANS[planId].transactionLimit).toBeGreaterThan(0);
      }
    });

    it("should have non-negative AI limits", () => {
      for (const planId of planIds) {
        expect(PLANS[planId].aiFairUseLimitEur).toBeGreaterThanOrEqual(0);
      }
    });

    it("should have non-negative prices", () => {
      for (const planId of planIds) {
        expect(PLANS[planId].monthlyPriceEur).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("default subscription alignment", () => {
    it("should match free plan AI limit in default subscription", () => {
      const data = createDefaultSubscriptionData("test");
      expect(data.aiFairUseLimitEur).toBe(PLANS.free.aiFairUseLimitEur);
    });

    it("should use free plan as default", () => {
      const data = createDefaultSubscriptionData("test");
      expect(data.plan).toBe("free");
    });

    it("should have all budget fields initialized to zero", () => {
      const data = createDefaultSubscriptionData("test");
      expect(data.aiUsageCurrentPeriodEur).toBe(0);
      expect(data.aiCreditsEur).toBe(0);
      expect(data.aiOverageCapEur).toBe(0);
      expect(data.aiOverageCurrentPeriodEur).toBe(0);
      expect(data.transactionCountCurrentMonth).toBe(0);
    });

    it("should have all warning flags initialized to false", () => {
      const data = createDefaultSubscriptionData("test");
      expect(data.aiWarning90Sent).toBe(false);
      expect(data.aiWarning100Sent).toBe(false);
      expect(data.aiPaused).toBe(false);
    });
  });

  describe("billing rate", () => {
    it("should be reasonable for user-facing pricing", () => {
      // At 0.35 EUR / 100k tokens:
      // A typical extraction (~2k tokens) costs about 0.007 EUR
      // 100 extractions = ~0.70 EUR (within starter fair use)
      const extractionTokens = 2000;
      const costPerExtraction = (extractionTokens / 100_000) * USER_TOKEN_RATE_PER_100K_EUR;
      expect(costPerExtraction).toBeLessThan(0.01);
      expect(costPerExtraction).toBeGreaterThan(0);
    });

    it("should make 100 extractions fit within starter plan", () => {
      const extractionTokens = 2000;
      const totalCost = 100 * (extractionTokens / 100_000) * USER_TOKEN_RATE_PER_100K_EUR;
      expect(totalCost).toBeLessThan(PLANS.starter.aiFairUseLimitEur);
    });
  });
});
