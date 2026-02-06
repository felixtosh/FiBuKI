/**
 * Tests for Transaction Scoring Module
 *
 * Covers:
 * - calculateDateScore with and without billing cycle
 * - calculateAmountScore
 * - calculatePartnerScore
 * - scoreTransaction with and without scoring weights
 * - namesMatch fuzzy comparison
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  calculateDateScore,
  calculateAmountScore,
  calculatePartnerScore,
  scoreTransaction,
  namesMatch,
  normalizeName,
  normalizeIban,
  formatScoreBreakdown,
  SCORING_CONFIG,
  BillingCycleHint,
  FileMatchingData,
  TransactionData,
} from "../transactionScoring";

// Helper to create a Timestamp from a date string
function ts(dateStr: string): Timestamp {
  return Timestamp.fromDate(new Date(dateStr));
}

// ============================================================================
// calculateDateScore
// ============================================================================

describe("calculateDateScore", () => {
  it("returns 25 for same day", () => {
    const result = calculateDateScore(
      new Date("2024-01-15"),
      new Date("2024-01-15")
    );
    expect(result.score).toBe(25);
    expect(result.source).toBe("date_exact");
  });

  it("returns 22 for 1-3 day difference", () => {
    expect(
      calculateDateScore(new Date("2024-01-15"), new Date("2024-01-17")).score
    ).toBe(22);
    expect(
      calculateDateScore(new Date("2024-01-15"), new Date("2024-01-18")).score
    ).toBe(22);
  });

  it("returns 15 for 4-7 day difference", () => {
    expect(
      calculateDateScore(new Date("2024-01-15"), new Date("2024-01-20")).score
    ).toBe(15);
  });

  it("returns 8 for 8-14 day difference", () => {
    expect(
      calculateDateScore(new Date("2024-01-15"), new Date("2024-01-25")).score
    ).toBe(8);
  });

  it("returns 3 for 15-30 day difference", () => {
    expect(
      calculateDateScore(new Date("2024-01-01"), new Date("2024-01-25")).score
    ).toBe(3);
  });

  it("returns 0 for >30 day difference", () => {
    expect(
      calculateDateScore(new Date("2024-01-01"), new Date("2024-03-01")).score
    ).toBe(0);
    expect(
      calculateDateScore(new Date("2024-01-01"), new Date("2024-03-01")).source
    ).toBeNull();
  });

  // === Billing cycle tests ===

  describe("with billing cycle", () => {
    it("boosts score when actual delay matches learned delay", () => {
      // Invoice Dec 1, transaction Dec 15 = 14 day delay
      // Without billing cycle: 14 days diff → score 8
      // With billing cycle (delay=14 ±3): matches perfectly → score 25
      const billingCycle: BillingCycleHint = {
        invoiceToTransactionDelay: 14,
        delayVariance: 3,
      };

      const result = calculateDateScore(
        new Date("2024-12-01"),
        new Date("2024-12-15"),
        billingCycle
      );
      expect(result.score).toBe(25);
      expect(result.source).toBe("date_exact");
    });

    it("gives 22 when delay is within 2x variance", () => {
      // Invoice Dec 1, transaction Dec 20 = 19 day delay
      // Expected delay: 14 ±3, so 2x variance = ±6
      // delayDiff = |19 - 14| = 5, which is > 3 but <= 6
      const billingCycle: BillingCycleHint = {
        invoiceToTransactionDelay: 14,
        delayVariance: 3,
      };

      const result = calculateDateScore(
        new Date("2024-12-01"),
        new Date("2024-12-20"),
        billingCycle
      );
      expect(result.score).toBe(22);
      expect(result.source).toBe("date_close");
    });

    it("falls through to standard scoring when delay does not match", () => {
      // Invoice Dec 1, transaction Jan 15 = 45 day delay
      // Expected: 14 ±3, actual: 45 → no match → standard scoring: daysDiff=45 → 0
      const billingCycle: BillingCycleHint = {
        invoiceToTransactionDelay: 14,
        delayVariance: 3,
      };

      const result = calculateDateScore(
        new Date("2024-12-01"),
        new Date("2025-01-15"),
        billingCycle
      );
      expect(result.score).toBe(0);
    });

    it("handles zero delay (invoice and transaction same day)", () => {
      const billingCycle: BillingCycleHint = {
        invoiceToTransactionDelay: 0,
        delayVariance: 2,
      };

      // Same day: actual delay = 0, expected = 0 → match
      const result = calculateDateScore(
        new Date("2024-06-15"),
        new Date("2024-06-15"),
        billingCycle
      );
      expect(result.score).toBe(25);
    });

    it("uses default variance of 3 when not specified", () => {
      const billingCycle: BillingCycleHint = {
        invoiceToTransactionDelay: 10,
        // No delayVariance → defaults to 3
      };

      // Actual delay: 12 days, expected: 10, diff = 2 → within 3 → match
      const result = calculateDateScore(
        new Date("2024-06-01"),
        new Date("2024-06-13"),
        billingCycle
      );
      expect(result.score).toBe(25);
    });

    it("ignores billing cycle when invoiceToTransactionDelay is undefined", () => {
      const billingCycle: BillingCycleHint = {
        delayVariance: 3,
        // No invoiceToTransactionDelay → skip billing cycle logic
      };

      // 14 day diff → standard scoring → 8
      const result = calculateDateScore(
        new Date("2024-06-01"),
        new Date("2024-06-15"),
        billingCycle
      );
      expect(result.score).toBe(8);
    });

    it("handles negative delay (transaction before invoice)", () => {
      const billingCycle: BillingCycleHint = {
        invoiceToTransactionDelay: -5, // tx happens 5 days BEFORE invoice
        delayVariance: 2,
      };

      // tx Jun 10, invoice Jun 15 → actual delay = 10-15 = -5
      const result = calculateDateScore(
        new Date("2024-06-15"), // file date (invoice)
        new Date("2024-06-10"), // tx date
        billingCycle
      );
      expect(result.score).toBe(25);
    });
  });
});

// ============================================================================
// calculateAmountScore
// ============================================================================

describe("calculateAmountScore", () => {
  it("returns 40 for exact match", () => {
    const result = calculateAmountScore(1000, 1000);
    expect(result.score).toBe(40);
    expect(result.source).toBe("amount_exact");
    expect(result.currencyMismatch).toBe(false);
  });

  it("returns 38 for within 1% difference", () => {
    const result = calculateAmountScore(10000, 10050); // 0.5% diff
    expect(result.score).toBe(38);
    expect(result.source).toBe("amount_close");
  });

  it("returns 30 for within 5% difference", () => {
    const result = calculateAmountScore(10000, 10400); // 4% diff
    expect(result.score).toBe(30);
  });

  it("returns 20 for within 10% difference", () => {
    const result = calculateAmountScore(10000, 10800); // 8% diff
    expect(result.score).toBe(20);
  });

  it("returns 0 for >10% difference", () => {
    const result = calculateAmountScore(10000, 15000); // 50% diff
    expect(result.score).toBe(0);
    expect(result.source).toBeNull();
  });

  it("returns 0 when either amount is 0", () => {
    expect(calculateAmountScore(0, 1000).score).toBe(0);
    expect(calculateAmountScore(1000, 0).score).toBe(0);
  });

  it("uses absolute values for comparison", () => {
    const result = calculateAmountScore(-1000, -1000);
    expect(result.score).toBe(40);
  });

  it("applies 50% penalty for currency mismatch", () => {
    const result = calculateAmountScore(1000, 1000, "USD", "EUR");
    expect(result.score).toBe(20); // 40 * 0.5
    expect(result.currencyMismatch).toBe(true);
  });

  it("treats null/undefined currency as EUR", () => {
    const result = calculateAmountScore(1000, 1000, null, undefined);
    expect(result.currencyMismatch).toBe(false);
  });
});

// ============================================================================
// namesMatch
// ============================================================================

describe("namesMatch", () => {
  it("returns 25 for exact match after normalization", () => {
    const result = namesMatch("Amazon", "amazon");
    expect(result.match).toBe(true);
    expect(result.score).toBe(25);
  });

  it("strips company suffixes (GmbH, AG, etc.)", () => {
    const result = namesMatch("Deutsche Telekom AG", "Deutsche Telekom");
    expect(result.match).toBe(true);
    expect(result.score).toBe(25);
  });

  it("returns 18 for contains match", () => {
    const result = namesMatch("Amazon", "Amazon EU S.a.r.l.");
    expect(result.match).toBe(true);
    expect(result.score).toBe(18);
  });

  it("returns 15 for 2+ word overlap", () => {
    const result = namesMatch("Google Cloud Platform", "Google Cloud Services");
    expect(result.match).toBe(true);
    expect(result.score).toBe(15);
  });

  it("returns 25 for exact match after suffix removal", () => {
    // normalizeName("Netflix Inc.") → "netflix" (removes "inc.")
    // normalizeName("Netflix") → "netflix"
    // Exact match = 25
    const result = namesMatch("Netflix", "Netflix Inc.");
    expect(result.match).toBe(true);
    expect(result.score).toBe(25);
  });

  it("returns 0 for no match", () => {
    const result = namesMatch("Amazon", "Microsoft");
    expect(result.match).toBe(false);
    expect(result.score).toBe(0);
  });
});

// ============================================================================
// normalizeName
// ============================================================================

describe("normalizeName", () => {
  it("lowercases and trims", () => {
    expect(normalizeName("  Hello World  ")).toBe("hello world");
  });

  it("removes GmbH suffix", () => {
    expect(normalizeName("Firma GmbH")).toBe("firma");
  });

  it("removes AG suffix", () => {
    expect(normalizeName("Deutsche Telekom AG")).toBe("deutsche telekom");
  });
});

// ============================================================================
// normalizeIban
// ============================================================================

describe("normalizeIban", () => {
  it("removes spaces and uppercases", () => {
    expect(normalizeIban("de89 3704 0044 0532 0130 00")).toBe(
      "DE89370400440532013000"
    );
  });
});

// ============================================================================
// scoreTransaction with ScoringOptions
// ============================================================================

describe("scoreTransaction", () => {
  const baseFileData: FileMatchingData = {
    extractedAmount: 10000, // 100.00 EUR
    extractedCurrency: "EUR",
    extractedDate: ts("2024-06-15"),
    extractedPartner: "Amazon",
    extractedIban: null,
    extractedText: null,
    partnerId: "partner-1",
  };

  const baseTxData: TransactionData = {
    id: "tx-1",
    amount: -10000,
    date: ts("2024-06-15"),
    currency: "EUR",
    name: "Amazon Purchase",
    partner: "Amazon",
    partnerId: "partner-1",
  };

  it("scores a perfect match close to 100", () => {
    const result = scoreTransaction(baseFileData, baseTxData);
    // Amount exact (40) + date exact (25) + partner ID match (25) = 90
    // But date boost for partner match: date 25 * 1.5 = 37.5 → 37
    // 40 + 37 + 25 = 102, capped at 100
    expect(result.confidence).toBe(100);
    expect(result.matchSources).toContain("amount_exact");
    expect(result.matchSources).toContain("date_exact");
    expect(result.matchSources).toContain("partner");
  });

  it("returns breakdown with all factors", () => {
    const result = scoreTransaction(baseFileData, baseTxData);
    expect(result.breakdown).toHaveProperty("amount");
    expect(result.breakdown).toHaveProperty("date");
    expect(result.breakdown).toHaveProperty("partner");
    expect(result.breakdown).toHaveProperty("iban");
    expect(result.breakdown).toHaveProperty("reference");
    expect(result.breakdown).toHaveProperty("hint");
  });

  it("includes preview data", () => {
    const result = scoreTransaction(baseFileData, baseTxData);
    expect(result.preview.amount).toBe(-10000);
    expect(result.preview.currency).toBe("EUR");
    expect(result.preview.name).toBe("Amazon Purchase");
  });

  describe("with scoring weights", () => {
    it("applies weight multipliers to factors", () => {
      const noDateFile: FileMatchingData = {
        ...baseFileData,
        extractedDate: null, // No date → date score = 0
        partnerId: null, // No partner ID match
        extractedPartner: null,
      };

      const resultDefault = scoreTransaction(noDateFile, baseTxData);
      // Only amount exact (40)
      expect(resultDefault.confidence).toBe(40);

      // With 1.5x amount weight
      const resultBoosted = scoreTransaction(noDateFile, baseTxData, undefined, {
        weights: { amountWeight: 1.5, dateWeight: 1, partnerWeight: 1 },
      });
      // 40 * 1.5 = 60
      expect(resultBoosted.confidence).toBe(60);
    });

    it("reduces score with low weight", () => {
      const noDateFile: FileMatchingData = {
        ...baseFileData,
        extractedDate: null,
        partnerId: null,
        extractedPartner: null,
      };

      const result = scoreTransaction(noDateFile, baseTxData, undefined, {
        weights: { amountWeight: 0.5, dateWeight: 1, partnerWeight: 1 },
      });
      // 40 * 0.5 = 20
      expect(result.confidence).toBe(20);
    });

    it("caps confidence at 100 even with boosted weights", () => {
      const result = scoreTransaction(baseFileData, baseTxData, undefined, {
        weights: { amountWeight: 2, dateWeight: 2, partnerWeight: 2 },
      });
      expect(result.confidence).toBeLessThanOrEqual(100);
    });
  });

  describe("with billing cycle", () => {
    it("passes billing cycle to date scoring", () => {
      // Invoice Jun 1, transaction Jun 15 = 14 day delay
      // Without billing cycle: 14 days → date score 8
      // With billing cycle (delay=14 ±3): → date score 25
      const fileData: FileMatchingData = {
        ...baseFileData,
        extractedDate: ts("2024-06-01"),
        partnerId: null,
        extractedPartner: null,
      };
      const txData: TransactionData = {
        ...baseTxData,
        date: ts("2024-06-15"),
        partnerId: undefined,
        partner: undefined,
        name: "Some Payment",
      };

      const resultWithout = scoreTransaction(fileData, txData);
      const resultWith = scoreTransaction(fileData, txData, undefined, {
        billingCycle: { invoiceToTransactionDelay: 14, delayVariance: 3 },
      });

      expect(resultWith.confidence).toBeGreaterThan(resultWithout.confidence);
    });
  });

  describe("partner scoring priority", () => {
    it("gives 25 for partner ID match", () => {
      const result = calculatePartnerScore(
        { ...baseFileData, partnerId: "p-1" },
        { ...baseTxData, partnerId: "p-1" }
      );
      expect(result.score).toBe(25);
    });

    it("gives 0 when no partner data", () => {
      const result = calculatePartnerScore(
        { ...baseFileData, partnerId: null, extractedPartner: null },
        { ...baseTxData, partnerId: undefined, name: "" }
      );
      expect(result.score).toBe(0);
    });

    it("uses partner aliases for matching", () => {
      const result = calculatePartnerScore(
        { ...baseFileData, partnerId: null, extractedPartner: null },
        { ...baseTxData, partnerId: undefined, name: "AMZN Marketplace" },
        ["Amazon", "AMZN Marketplace"]
      );
      expect(result.score).toBeGreaterThan(0);
    });
  });

  describe("date-partner boost interaction", () => {
    it("boosts date score 50% when partner matches well", () => {
      const fileData: FileMatchingData = {
        ...baseFileData,
        extractedAmount: null, // No amount to simplify
      };
      const txData: TransactionData = {
        ...baseTxData,
        amount: 0,
      };

      const result = scoreTransaction(fileData, txData);
      // Partner ID match = 25, date exact = 25 → boosted 50% = 37
      expect(result.breakdown.date).toBe(37);
    });

    it("penalizes partner score when date is poor", () => {
      const fileData: FileMatchingData = {
        ...baseFileData,
        extractedDate: ts("2024-01-01"),
        extractedAmount: null,
      };
      const txData: TransactionData = {
        ...baseTxData,
        date: ts("2024-06-15"), // 166 days away → date score 0
        amount: 0,
      };

      const result = scoreTransaction(fileData, txData);
      // Partner ID match = 25, but date = 0 → partner reduced to 60% = 15
      expect(result.breakdown.partner).toBe(15);
    });
  });
});

// ============================================================================
// formatScoreBreakdown
// ============================================================================

describe("formatScoreBreakdown", () => {
  it("formats non-zero factors", () => {
    const result = formatScoreBreakdown({
      amount: 40,
      date: 25,
      partner: 0,
      iban: 0,
      reference: 5,
      hint: 0,
    });
    expect(result).toBe("amt:40 + date:25 + ref:5");
  });

  it("returns empty string for all-zero breakdown", () => {
    const result = formatScoreBreakdown({
      amount: 0,
      date: 0,
      partner: 0,
      iban: 0,
      reference: 0,
      hint: 0,
    });
    expect(result).toBe("");
  });
});

// ============================================================================
// SCORING_CONFIG
// ============================================================================

describe("SCORING_CONFIG", () => {
  it("has expected thresholds", () => {
    expect(SCORING_CONFIG.AUTO_MATCH_THRESHOLD).toBe(85);
    expect(SCORING_CONFIG.SUGGESTION_THRESHOLD).toBe(50);
    expect(SCORING_CONFIG.DATE_RANGE_DAYS).toBe(30);
    expect(SCORING_CONFIG.MAX_SUGGESTIONS).toBe(5);
  });
});
