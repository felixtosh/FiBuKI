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

  // Fork #87: a currency-mismatched pair is scored on FX plausibility, not on
  // the raw numbers — USD 24.00 and EUR 20.86 never agree numerically.
  it("currency mismatch: a plausible FX ratio scores 30 as amount_close", () => {
    const result = calculateAmountScore(2400, 2086, "USD", "EUR"); // 0.869 EUR/USD
    expect(result.currencyMismatch).toBe(true);
    expect(result.score).toBe(30);
    expect(result.source).toBe("amount_close");
  });

  it("currency mismatch: a loosely plausible ratio scores 20", () => {
    const result = calculateAmountScore(10000, 9500, "USD", "EUR"); // 0.95, ~8% off anchor
    expect(result.currencyMismatch).toBe(true);
    expect(result.score).toBe(20);
    expect(result.source).toBe("amount_close");
  });

  it("currency mismatch: a numerically equal amount is NOT an exact match", () => {
    // USD 10.00 vs EUR 10.00 — the old code reported amount_exact (halved to
    // 20). 1:1 is inside the loose FX band (2022 parity), so it still scores
    // 20, but as amount_close: it can never earn the hard-facts bonus.
    const result = calculateAmountScore(1000, 1000, "USD", "EUR");
    expect(result.currencyMismatch).toBe(true);
    expect(result.score).toBe(20);
    expect(result.source).toBe("amount_close");
  });

  it("currency mismatch: a ratio outside the loose band scores 0", () => {
    const result = calculateAmountScore(1000, 1100, "USD", "EUR"); // 1.10 EUR/USD
    expect(result.score).toBe(0);
    expect(result.source).toBeNull();
  });

  it("currency mismatch: an implausible ratio scores 0", () => {
    const result = calculateAmountScore(12000, 5000, "USD", "EUR"); // partial payment shape
    expect(result.score).toBe(0);
    expect(result.source).toBeNull();
  });

  it("currency mismatch: unknown currency falls back to the halved numeric ladder", () => {
    // no anchor for XYZ — often a garbled tag on a EUR document
    expect(calculateAmountScore(1000, 880, "XYZ", "EUR").score).toBe(0);
    const exact = calculateAmountScore(1000, 1000, "XYZ", "EUR");
    expect(exact.currencyMismatch).toBe(true);
    expect(exact.score).toBe(20);
    expect(exact.source).toBe("amount_exact");
  });

  it("currency mismatch: a legacy '$' tag scores like USD", () => {
    expect(calculateAmountScore(2400, 2086, "$", "EUR").score).toBe(30);
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
    expect(result.breakdown).toHaveProperty("hardFacts");
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

  // Fork #78: exact amount + exact date used to cap at 65 (< 85), so
  // auto-connect depended on partner identity rather than the hard facts.
  describe("hard-facts combination bonus (fork #78)", () => {
    // No partner signal on either side: only amount + date can score.
    const noPartnerFile: FileMatchingData = {
      ...baseFileData,
      partnerId: null,
      extractedPartner: null,
    };
    const noPartnerTx: TransactionData = {
      ...baseTxData,
      partnerId: undefined,
      partner: undefined,
      name: "AMAZON* NI42Y4HY4",
    };

    it("exact amount + same day clears the auto-match threshold on its own", () => {
      const result = scoreTransaction(noPartnerFile, noPartnerTx);
      // 40 (amount) + 25 (date) + 20 (bonus) = 85
      expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
      expect(result.confidence).toBe(85);
      expect(result.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
      expect(result.matchSources).not.toContain("partner");
    });

    it("exact amount within 3 days is a strong suggestion but not an auto-match", () => {
      const result = scoreTransaction(
        { ...noPartnerFile, extractedDate: ts("2024-06-14") },
        noPartnerTx
      );
      // 40 + 22 + 15 = 77
      expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_CLOSE);
      expect(result.confidence).toBe(77);
      expect(result.confidence).toBeLessThan(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
    });

    it("exact amount within 3 days plus a weak partner text match auto-matches", () => {
      // The live case from #78: Amazon Business EU vs "AMAZON* ..." scored 74
      // (40 + 22 + 12) and was left for manual review.
      const result = scoreTransaction(
        {
          ...noPartnerFile,
          extractedDate: ts("2024-06-14"),
          extractedPartner: "Amazon Business EU",
        },
        noPartnerTx
      );
      expect(result.breakdown.partner).toBe(12);
      // 40 + 22 + 12 + 15 = 89
      expect(result.confidence).toBe(89);
      expect(result.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
    });

    it("no bonus when the amount is only close (within 1%)", () => {
      const result = scoreTransaction(
        { ...noPartnerFile, extractedAmount: 10050 },
        noPartnerTx
      );
      // 38 + 25 = 63
      expect(result.breakdown.hardFacts).toBe(0);
      expect(result.confidence).toBe(63);
    });

    it("no bonus when the amount is a plausible FX match in another currency", () => {
      // USD 113.64 ≈ EUR 100.00 at 0.88: FX-plausible (30) but never "exact"
      const result = scoreTransaction(
        { ...noPartnerFile, extractedAmount: 11364, extractedCurrency: "USD" },
        noPartnerTx
      );
      // 30 + 25 = 55
      expect(result.matchSources).toContain("amount_close");
      expect(result.matchSources).not.toContain("amount_exact");
      expect(result.breakdown.hardFacts).toBe(0);
      expect(result.confidence).toBe(55);
    });

    it("no bonus when the date is more than 3 days off", () => {
      const result = scoreTransaction(
        { ...noPartnerFile, extractedDate: ts("2024-06-10") },
        noPartnerTx
      );
      // 40 + 15 = 55
      expect(result.breakdown.hardFacts).toBe(0);
      expect(result.confidence).toBe(55);
    });

    it("bonus is decided on the raw date score, before the partner date boost", () => {
      // Partner ID match (25) boosts date 25 -> 37; the bonus must still be the
      // same-day one, and the total caps at 100.
      const result = scoreTransaction(baseFileData, baseTxData);
      expect(result.breakdown.date).toBe(37);
      expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
      expect(result.confidence).toBe(100);
    });

    it("a learned billing-cycle delay counts as an exact date", () => {
      // Invoice Jun 1, debit Jun 15, learned delay 14 +/- 3 -> date 25 -> bonus 20
      const result = scoreTransaction(
        { ...noPartnerFile, extractedDate: ts("2024-06-01") },
        noPartnerTx,
        undefined,
        { billingCycle: { invoiceToTransactionDelay: 14, delayVariance: 3 } }
      );
      expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
      expect(result.confidence).toBe(85);
    });

    it("bonus is not scaled by per-partner weights", () => {
      // amountWeight 0.5 halves the amount to 20; the bonus still applies but
      // 20 + 25 + 20 = 65 stays below the threshold.
      const result = scoreTransaction(noPartnerFile, noPartnerTx, undefined, {
        weights: { amountWeight: 0.5, dateWeight: 1, partnerWeight: 1 },
      });
      expect(result.breakdown.hardFacts).toBe(SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY);
      expect(result.confidence).toBe(65);
    });
  });

  describe("foreign-currency subscriptions (fork #87)", () => {
    // Live pair: paperless-ap-1108.pdf OpenAI USD 24.00 2026-04-02 vs
    // "OPENAI *CHATGPT SUBSCR" EUR 20.86 2026-04-03. Scored 58
    // (date_close 33 + partner 25) with zero amount points before #87.
    const usdFile: FileMatchingData = {
      extractedAmount: 2400,
      extractedCurrency: "USD",
      extractedDate: ts("2026-04-02"),
      extractedPartner: "OpenAI",
      partnerId: "p-openai",
    };
    const eurTx: TransactionData = {
      id: "tx-openai",
      amount: -2086,
      currency: "EUR",
      date: ts("2026-04-03"),
      name: "OPENAI *CHATGPT SUBSCR",
      partnerId: "p-openai",
    };

    it("plausible FX + partner + next-day date auto-matches", () => {
      const result = scoreTransaction(usdFile, eurTx);
      // 30 (fx amount) + 33 (22 boosted by partner) + 25 (partner id) = 88
      expect(result.breakdown.amount).toBe(30);
      expect(result.confidence).toBe(88);
      expect(result.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
      expect(result.matchSources).toContain("amount_close");
    });

    it("plausible FX + date alone stays a suggestion, never an auto-match", () => {
      const result = scoreTransaction(
        { ...usdFile, extractedPartner: null, partnerId: null },
        { ...eurTx, partnerId: undefined, name: "CARD PAYMENT" }
      );
      // 30 + 22 = 52
      expect(result.confidence).toBe(52);
      expect(result.confidence).toBeLessThan(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
      expect(result.breakdown.hardFacts).toBe(0);
    });

    it("same partner but implausible FX ratio scores like before (no amount points)", () => {
      const result = scoreTransaction(usdFile, { ...eurTx, amount: -6000 });
      expect(result.breakdown.amount).toBe(0);
      expect(result.confidence).toBe(58);
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
