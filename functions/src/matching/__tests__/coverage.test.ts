/**
 * Coverage and the Remainder (#239).
 *
 * Covers the derivation itself and what the scorer does with it across the
 * five states a Transaction can be in: holding no Files, partly documented
 * with a candidate that closes what is left, partly documented with one that
 * does not, exactly documented, and over-documented.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import {
  COVERAGE_RATIO,
  REMAINDER_CLOSE_TOLERANCE,
  deriveCoverage,
  documentedAmountOf,
  filePaymentTotal,
  isRemainderClosed,
} from "../coverage";
import {
  SCORING_CONFIG,
  formatScoreBreakdown,
  isRemainderMatch,
  scoreTransaction,
  FileMatchingData,
  TransactionData,
} from "../transactionScoring";
import { scoreAttachmentMatch } from "../../precision-search/scoreAttachmentMatch";

function ts(dateStr: string): Timestamp {
  return Timestamp.fromDate(new Date(dateStr));
}

// ============================================================================
// deriveCoverage
// ============================================================================

describe("deriveCoverage", () => {
  it("scores against the full amount when no files are connected", () => {
    const coverage = deriveCoverage(-50000, 0);
    expect(coverage.remainder).toBe(50000);
    expect(coverage.againstRemainder).toBe(false);
    expect(coverage.scoreAgainst).toBe(50000);
    expect(coverage.isCovered).toBe(false);
  });

  it("scores against the remainder when the transaction is partly documented", () => {
    // A 500,00 bank line with a 285,80 invoice on it leaves 214,20.
    const coverage = deriveCoverage(-50000, 28580);
    expect(coverage.remainder).toBe(21420);
    expect(coverage.againstRemainder).toBe(true);
    expect(coverage.scoreAgainst).toBe(21420);
    expect(coverage.isCovered).toBe(false);
  });

  it("is covered at the coverage ratio and back on the full amount at zero remainder", () => {
    const exact = deriveCoverage(-50000, 50000);
    expect(exact.remainder).toBe(0);
    // Nothing may earn a perfect hit against 0,00.
    expect(exact.againstRemainder).toBe(false);
    expect(exact.scoreAgainst).toBe(50000);
    expect(exact.isCovered).toBe(true);

    const atRatio = deriveCoverage(-50000, 45000);
    expect(atRatio.ratio).toBe(COVERAGE_RATIO);
    expect(atRatio.isCovered).toBe(true);
    // Covered, but the last 50,00 is still open and still scored on.
    expect(atRatio.againstRemainder).toBe(true);
  });

  it("treats an over-documented transaction as fully documented, not twice", () => {
    const coverage = deriveCoverage(-50000, 62000);
    expect(coverage.remainder).toBe(-12000);
    expect(coverage.againstRemainder).toBe(false);
    expect(coverage.scoreAgainst).toBe(50000);
    expect(coverage.isCovered).toBe(true);
  });

  it("reads the sign off neither side", () => {
    expect(deriveCoverage(50000, 28580)).toEqual(deriveCoverage(-50000, -28580));
  });

  it("does not divide by a zero-amount line", () => {
    const coverage = deriveCoverage(0, 0);
    expect(coverage.ratio).toBe(0);
    expect(coverage.isCovered).toBe(false);
  });
});

describe("documentedAmountOf", () => {
  it("sums payment totals as magnitudes and ignores files with no amount", () => {
    expect(documentedAmountOf([28580, null, -1200, undefined])).toBe(29780);
  });

  it("counts a printed Trinkgeld, because the bank was charged it (#172)", () => {
    const withTip = filePaymentTotal(2000, 300);
    expect(documentedAmountOf([withTip])).toBe(2300);
  });
});

describe("isRemainderClosed", () => {
  it("forgives a gap of up to one euro, in either direction", () => {
    expect(isRemainderClosed(0)).toBe(true);
    expect(isRemainderClosed(REMAINDER_CLOSE_TOLERANCE)).toBe(true);
    expect(isRemainderClosed(-REMAINDER_CLOSE_TOLERANCE)).toBe(true);
    expect(isRemainderClosed(REMAINDER_CLOSE_TOLERANCE + 1)).toBe(false);
  });
});

describe("SCORING_CONFIG carries both tolerances", () => {
  it("names the coverage ratio and the remainder-close tolerance", () => {
    expect(SCORING_CONFIG.COVERAGE_RATIO).toBe(0.9);
    expect(SCORING_CONFIG.REMAINDER_CLOSE_TOLERANCE).toBe(100);
    expect(SCORING_CONFIG.COVERAGE_RATIO).toBe(COVERAGE_RATIO);
    expect(SCORING_CONFIG.REMAINDER_CLOSE_TOLERANCE).toBe(REMAINDER_CLOSE_TOLERANCE);
  });
});

// ============================================================================
// scoreTransaction against a Remainder
// ============================================================================

describe("scoreTransaction against a remainder", () => {
  // A 214,20 document, same day as the bank line, no partner signal on either
  // side so only the amount and the date can score.
  const candidate: FileMatchingData = {
    extractedAmount: 21420,
    extractedCurrency: "EUR",
    extractedDate: ts("2024-06-15"),
    extractedPartner: null,
    partnerId: null,
  };

  // A 500,00 expense with a 285,80 invoice already on it: 214,20 left.
  const partlyDocumented: TransactionData = {
    id: "tx1",
    amount: -50000,
    date: ts("2024-06-15"),
    currency: "EUR",
    name: "KARTENZAHLUNG",
    documentedAmount: 28580,
  };

  it("closes the remainder: an amount hit, above the suggestion threshold", () => {
    const result = scoreTransaction(candidate, partlyDocumented);

    expect(result.breakdown.amount).toBe(40);
    expect(result.matchSources).toContain("amount_exact");
    expect(result.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.SUGGESTION_THRESHOLD);
  });

  it("says so in its match sources and its stored breakdown", () => {
    const result = scoreTransaction(candidate, partlyDocumented);

    expect(result.matchSources).toContain("amount_remainder");
    expect(result.breakdown.scoredAgainstRemainder).toBe(21420);
    expect(isRemainderMatch(result)).toBe(true);
  });

  it("forgives a rounding-sized gap the relative ladder cannot see", () => {
    // 5,80 left, a 5,00 document: 16% off relatively, 80 cents absolutely.
    const smallRemainder: TransactionData = {
      ...partlyDocumented,
      amount: -3000,
      documentedAmount: 2420,
    };
    const result = scoreTransaction(
      { ...candidate, extractedAmount: 500 },
      smallRemainder
    );

    expect(result.breakdown.amount).toBe(30);
    expect(result.matchSources).toContain("amount_close");
    expect(result.matchSources).toContain("amount_remainder");
  });

  it("scores no amount hit for a candidate that does not close the remainder", () => {
    const result = scoreTransaction(
      { ...candidate, extractedAmount: 9900 },
      partlyDocumented
    );

    expect(result.breakdown.amount).toBe(0);
    expect(result.matchSources).not.toContain("amount_exact");
    expect(result.matchSources).not.toContain("amount_close");
    // Still a Remainder Match: the pair was judged against the Remainder and
    // found wanting, which is what the breakdown has to be able to say.
    expect(result.matchSources).toContain("amount_remainder");
  });

  it("scores no amount hit against a fully documented transaction", () => {
    const fullyDocumented: TransactionData = {
      ...partlyDocumented,
      documentedAmount: 50000,
    };
    const result = scoreTransaction(candidate, fullyDocumented);

    expect(result.breakdown.amount).toBe(0);
    expect(result.breakdown.scoredAgainstRemainder).toBeUndefined();
    expect(result.matchSources).not.toContain("amount_remainder");
    expect(isRemainderMatch(result)).toBe(false);
  });

  it("scores no amount hit against an over-documented transaction", () => {
    const overDocumented: TransactionData = {
      ...partlyDocumented,
      documentedAmount: 62000,
    };
    const result = scoreTransaction(candidate, overDocumented);

    expect(result.breakdown.amount).toBe(0);
    expect(isRemainderMatch(result)).toBe(false);
  });

  it("scores against the full amount when no files are connected", () => {
    const undocumented: TransactionData = { ...partlyDocumented, documentedAmount: 0 };
    const result = scoreTransaction(
      { ...candidate, extractedAmount: 50000 },
      undocumented
    );

    expect(result.breakdown.amount).toBe(40);
    expect(isRemainderMatch(result)).toBe(false);
  });

  // #104 suppresses a document that is redundant against what the target
  // already holds. A candidate that closes the Remainder is not redundant —
  // it explains a different part of the same line.
  describe("against the documentation rule (#104)", () => {
    const documentedByInvoice: TransactionData = {
      ...partlyDocumented,
      documentationState: "invoice",
    };
    const invoice: FileMatchingData = { ...candidate, documentType: "invoice" };

    it("caps rather than suppresses the invoice that closes the remainder", () => {
      const result = scoreTransaction(invoice, documentedByInvoice);

      expect(result.documentation?.outcome).toBe("capped");
      expect(result.confidence).toBeGreaterThanOrEqual(SCORING_CONFIG.SUGGESTION_THRESHOLD);
      expect(result.confidence).toBeLessThan(SCORING_CONFIG.AUTO_MATCH_THRESHOLD);
    });

    it("still suppresses one that does not close it", () => {
      const result = scoreTransaction(
        { ...invoice, extractedAmount: 9900 },
        documentedByInvoice
      );

      expect(result.documentation?.outcome).toBe("suppressed");
      expect(result.confidence).toBe(0);
    });

    it("still suppresses against a fully documented line", () => {
      const result = scoreTransaction(invoice, {
        ...documentedByInvoice,
        documentedAmount: 50000,
      });

      expect(result.documentation?.outcome).toBe("suppressed");
      expect(result.confidence).toBe(0);
    });
  });

  it("leaves a foreign-currency document on the full amount: a remainder has no bank original", () => {
    const result = scoreTransaction(
      { ...candidate, extractedCurrency: "USD" },
      partlyDocumented
    );

    expect(isRemainderMatch(result)).toBe(false);
    expect(result.matchSources).not.toContain("amount_remainder");
  });

  it("names the figure it scored against in the formatted breakdown", () => {
    const result = scoreTransaction(candidate, partlyDocumented);
    expect(formatScoreBreakdown(result.breakdown)).toContain("vs-remainder:214.20");
  });
});

// ============================================================================
// The other scoring path: a candidate File for a given Transaction
// ============================================================================

describe("scoreAttachmentMatch against a remainder", () => {
  // Same 500,00 line, same 285,80 already on it, same 214,20 candidate — the
  // two scorers have to agree about which figure is open.
  const base = {
    filename: "rechnung.pdf",
    mimeType: "application/pdf",
    transactionAmount: -50000,
    transactionDate: new Date("2024-06-15"),
    fileExtractedDate: new Date("2024-06-15"),
    fileExtractedAmount: 21420,
  };

  it("closes the remainder: an exact hit, said out loud", () => {
    const result = scoreAttachmentMatch({ ...base, transactionDocumentedAmount: 28580 });

    expect(result.scoredAgainstRemainder).toBe(true);
    expect(result.reasons).toContain("Exact amount match (remainder)");
  });

  it("forgives a rounding-sized gap the relative ladder cannot see", () => {
    const result = scoreAttachmentMatch({
      ...base,
      transactionAmount: -3000,
      transactionDocumentedAmount: 2420,
      fileExtractedAmount: 500,
    });

    expect(result.reasons).toContain("Closes the remainder");
  });

  it("scores against the full amount once the transaction is fully documented", () => {
    const result = scoreAttachmentMatch({ ...base, transactionDocumentedAmount: 50000 });

    expect(result.scoredAgainstRemainder).toBe(false);
    expect(result.reasons).not.toContain("Exact amount match (remainder)");
  });

  it("is unchanged for a transaction that holds no files", () => {
    const withoutCoverage = scoreAttachmentMatch(base);
    const explicitlyEmpty = scoreAttachmentMatch({
      ...base,
      transactionDocumentedAmount: 0,
    });

    expect(withoutCoverage.scoredAgainstRemainder).toBe(false);
    expect(withoutCoverage).toEqual(explicitlyEmpty);
  });
});
