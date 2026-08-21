/**
 * Tests for the pure billing-cycle derivation in ../billingCycle.ts — the
 * interval-detection algorithm, amount-band splitting, and declared/learned
 * resolution. The callable that wraps this with Firestore I/O is covered by
 * the characterization suite (functions/src/selfhost/matching-characterization.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  findModeInterval,
  computeMode,
  deriveLearnedCycles,
  resolveEffectiveCycles,
  selectEffectiveCycleForAmount,
  type BillingCycleTransaction,
} from "../billingCycle";

// ============================================================================
// findModeInterval
// ============================================================================

describe("findModeInterval", () => {
  it("detects monthly billing (30 day intervals)", () => {
    const intervals = [29, 31, 30, 28, 31, 30, 29];
    const result = findModeInterval(intervals, 5);
    expect(result).not.toBeNull();
    expect(result!.modeInterval).toBe(30);
    expect(result!.count).toBe(7); // All within ±5 of 30
  });

  it("detects quarterly billing (90 day intervals)", () => {
    const intervals = [89, 92, 88, 91, 87];
    const result = findModeInterval(intervals, 5);
    expect(result).not.toBeNull();
    expect(result!.modeInterval).toBe(90);
    expect(result!.count).toBe(5);
  });

  it("detects yearly billing (365 day intervals)", () => {
    const intervals = [364, 366, 365];
    const result = findModeInterval(intervals, 5);
    expect(result).not.toBeNull();
    expect(result!.modeInterval).toBe(365);
    expect(result!.count).toBe(3);
  });

  it("detects weekly billing (7 day intervals)", () => {
    const intervals = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
    const result = findModeInterval(intervals, 5);
    expect(result).not.toBeNull();
    expect(result!.modeInterval).toBe(7);
    expect(result!.count).toBe(10);
  });

  it("handles mixed intervals and finds the dominant one", () => {
    // 4 monthly + 2 random
    const intervals = [30, 31, 29, 30, 90, 15];
    const result = findModeInterval(intervals, 5);
    expect(result).not.toBeNull();
    expect(result!.modeInterval).toBe(30);
    expect(result!.count).toBe(4);
  });

  it("returns null for empty intervals", () => {
    expect(findModeInterval([], 5)).toBeNull();
  });

  it("handles a single interval", () => {
    const result = findModeInterval([30], 5);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
  });

  it("handles irregular intervals with no clear pattern", () => {
    const intervals = [10, 45, 72, 3, 120];
    const result = findModeInterval(intervals, 5);
    // Should find something, but count will be low
    expect(result).not.toBeNull();
    expect(result!.count).toBeLessThanOrEqual(2);
  });
});

// ============================================================================
// computeMode
// ============================================================================

describe("computeMode", () => {
  it("finds the most frequent value", () => {
    expect(computeMode([15, 15, 15, 1, 28])).toBe(15);
  });

  it("handles single value", () => {
    expect(computeMode([42])).toBe(42);
  });

  it("returns first mode on tie", () => {
    const result = computeMode([1, 2, 1, 2]);
    expect([1, 2]).toContain(result);
  });
});

// ============================================================================
// deriveLearnedCycles
// ============================================================================

function tx(
  date: string,
  amount: number,
  invoiceDates?: string | string[]
): BillingCycleTransaction {
  const dates = invoiceDates
    ? (Array.isArray(invoiceDates) ? invoiceDates : [invoiceDates]).map((d) => new Date(d))
    : undefined;
  return {
    date: new Date(date),
    amount,
    ...(dates ? { invoiceDates: dates } : {}),
  };
}

describe("deriveLearnedCycles", () => {
  it("detects a clean monthly partner as a single band", () => {
    const transactions = [
      tx("2024-01-15", 30),
      tx("2024-02-15", 30),
      tx("2024-03-15", 30),
      tx("2024-04-15", 30),
      tx("2024-05-15", 30),
      tx("2024-06-15", 30),
    ];
    const cycles = deriveLearnedCycles(transactions);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].amountBand).toBeUndefined();
    expect(cycles[0].frequencyDays).toBeCloseTo(30, -1);
    expect(cycles[0].frequencyConfidence).toBeGreaterThan(50);
    expect(cycles[0].sampleSize).toBe(6);
  });

  it("bands by the billed-currency amount, not an FX-drifted one", () => {
    // A 20.00 USD subscription: same billed amount every month even though
    // the EUR-converted amount the caller would otherwise pass in drifts
    // with the exchange rate (18.40, 19.10, 18.75, ...). Feeding the billed
    // amount keeps these in one band instead of splitting into noise.
    const transactions = [
      tx("2024-01-05", 20.0),
      tx("2024-02-05", 20.0),
      tx("2024-03-05", 20.0),
      tx("2024-04-05", 20.0),
    ];
    const cycles = deriveLearnedCycles(transactions);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].amountBand).toBeUndefined();
    expect(cycles[0].frequencyDays).toBeCloseTo(30, -1);
  });

  it("splits an Anthropic-shaped history into a weekly band and a monthly band", () => {
    const weekly = [
      tx("2024-01-01", 38.25),
      tx("2024-01-08", 38.25),
      tx("2024-01-15", 38.25),
      tx("2024-01-22", 38.25),
      tx("2024-01-29", 38.25),
    ];
    const monthly = [
      tx("2024-01-03", 90),
      tx("2024-02-03", 90),
      tx("2024-03-03", 90),
      tx("2024-04-03", 90),
    ];
    const cycles = deriveLearnedCycles([...weekly, ...monthly]);
    expect(cycles).toHaveLength(2);

    const weeklyBand = cycles.find((c) => c.frequencyDays === 7);
    const monthlyBand = cycles.find((c) => c.frequencyDays !== 7);
    expect(weeklyBand?.amountBand).toBeCloseTo(38.25, 2);
    expect(monthlyBand?.amountBand).toBeCloseTo(90, 2);
    expect(monthlyBand?.frequencyDays).toBeCloseTo(30, -1);
  });

  it("yields no cycle with too few transactions", () => {
    const transactions = [tx("2024-01-15", 30), tx("2024-02-15", 30)];
    expect(deriveLearnedCycles(transactions)).toEqual([]);
  });

  it("yields no cycle for an irregular partner", () => {
    const transactions = [
      tx("2024-01-01", 50),
      tx("2024-01-15", 50), // +14
      tx("2024-03-20", 50), // +65
      tx("2024-04-01", 50), // +12
      tx("2024-07-10", 50), // +100
    ];
    expect(deriveLearnedCycles(transactions)).toEqual([]);
  });

  it("computes the invoice-to-transaction delay from connected-file dates", () => {
    const transactions = [
      tx("2024-01-15", 30, "2024-01-10"),
      tx("2024-02-15", 30, "2024-02-10"),
      tx("2024-03-15", 30, "2024-03-10"),
      tx("2024-04-15", 30, "2024-04-10"),
    ];
    const cycles = deriveLearnedCycles(transactions);
    expect(cycles[0].invoiceToTransactionDelay).toBe(5);
    expect(cycles[0].delayVariance).toBe(0);
  });

  it("counts one delay sample per connected file, not per transaction", () => {
    // Only 2 transactions carry a file, but the first has two connected
    // files (e.g. an invoice plus a credit note) — 3 delay samples total,
    // meeting the minimum even though only 2 transactions have any.
    const transactions = [
      tx("2024-01-15", 30, ["2024-01-10", "2024-01-11"]),
      tx("2024-02-15", 30, "2024-02-10"),
      tx("2024-03-15", 30),
      tx("2024-04-15", 30),
    ];
    const cycles = deriveLearnedCycles(transactions);
    // delays: 5, 4, 5 -> mean 4.67 -> rounds to 5
    expect(cycles[0].invoiceToTransactionDelay).toBe(5);
  });

  it("omits the delay fields entirely with fewer than 3 invoice delays", () => {
    const transactions = [
      tx("2024-01-15", 30),
      tx("2024-02-15", 30),
      tx("2024-03-15", 30),
      tx("2024-04-15", 30),
    ];
    const cycles = deriveLearnedCycles(transactions);
    expect("invoiceToTransactionDelay" in cycles[0]).toBe(false);
    expect("delayVariance" in cycles[0]).toBe(false);
  });
});

// ============================================================================
// resolveEffectiveCycles
// ============================================================================

describe("resolveEffectiveCycles", () => {
  it("falls back to the learned cycle when nothing is declared", () => {
    const learned = [
      { frequencyDays: 30, frequencyConfidence: 90, sampleSize: 6 },
    ];
    const effective = resolveEffectiveCycles(learned, []);
    expect(effective).toEqual([
      expect.objectContaining({ source: "learned", frequencyDays: 30, frequencyConfidence: 90 }),
    ]);
  });

  it("lets a single declared cycle win over the single learned one, inheriting its day/delay", () => {
    const learned = [
      {
        frequencyDays: 31, // noisy learned value
        frequencyConfidence: 60,
        typicalDayOfMonth: 15,
        invoiceToTransactionDelay: 5,
        delayVariance: 1,
        sampleSize: 4,
      },
    ];
    const declared = [{ frequencyDays: 30, documentExpectation: "invoice" as const }];
    const effective = resolveEffectiveCycles(learned, declared);
    expect(effective).toEqual([
      expect.objectContaining({
        source: "declared",
        frequencyDays: 30,
        typicalDayOfMonth: 15,
        invoiceToTransactionDelay: 5,
        documentExpectation: "invoice",
      }),
    ]);
  });

  it("resolves per band: a declared band wins its match, an undeclared band stays learned", () => {
    const learned = [
      { amountBand: 38.25, frequencyDays: 7, frequencyConfidence: 95, sampleSize: 5 },
      { amountBand: 90, frequencyDays: 30, frequencyConfidence: 90, sampleSize: 4 },
    ];
    const declared = [
      { amountBand: 90, expectedAmountMin: 80, expectedAmountMax: 200, frequencyDays: 30 },
    ];
    const effective = resolveEffectiveCycles(learned, declared);
    expect(effective).toHaveLength(2);
    expect(effective.find((c) => c.amountBand === 90)?.source).toBe("declared");
    expect(effective.find((c) => c.amountBand === 38.25)?.source).toBe("learned");
  });

  it("matches a scoped declared cycle to the single learned band, which never carries an amountBand itself", () => {
    const learned = [
      { frequencyDays: 31, frequencyConfidence: 60, typicalDayOfMonth: 15, sampleSize: 4 },
    ];
    const declared = [{ amountBand: 20, frequencyDays: 30 }];
    const effective = resolveEffectiveCycles(learned, declared);
    expect(effective).toEqual([
      expect.objectContaining({ source: "declared", frequencyDays: 30, typicalDayOfMonth: 15 }),
    ]);
  });

  it("sorts an unmatched declared cycle after real learned bands, not ahead of them", () => {
    const learned = [
      { amountBand: 38.25, frequencyDays: 7, frequencyConfidence: 95, sampleSize: 5 },
      { amountBand: 90, frequencyDays: 30, frequencyConfidence: 90, sampleSize: 4 },
    ];
    const declared = [{ frequencyDays: 30 }]; // no amountBand — ambiguous against 2 bands
    const effective = resolveEffectiveCycles(learned, declared);
    // The declared entry surfaces unenriched, but a consumer picking
    // effective[0] must land on real learned signal, not the placeholder.
    expect(effective).toHaveLength(3);
    expect(effective[0].source).toBe("learned");
    expect(effective[1].source).toBe("learned");
    expect(effective[2].source).toBe("declared");
  });
});

// ============================================================================
// selectEffectiveCycleForAmount (yazzbert/FiBuKI-selfhost#168)
// ============================================================================

describe("selectEffectiveCycleForAmount", () => {
  it("returns undefined with no bands", () => {
    expect(selectEffectiveCycleForAmount([], 100)).toBeUndefined();
  });

  it("returns the sole band unconditionally when it carries no amountBand (true single-cycle partner)", () => {
    const effective = [{ source: "learned" as const, frequencyDays: 30 }];
    expect(selectEffectiveCycleForAmount(effective, 999999)).toBe(effective[0]);
  });

  // Regression: deriveLearnedCycles stamps amountBand onto every surviving
  // band once clustering found MORE than one band, even if only one band
  // went on to produce a valid cycle (e.g. a 1-member band below the
  // minimum-sample threshold gets dropped, leaving a length-1 array whose
  // sole entry still carries the amountBand from when there were 2 bands).
  // Length alone must not bypass the tolerance check in that case.
  it("still applies the tolerance check when a length-1 array's sole band carries an amountBand", () => {
    const effective = [{ source: "learned" as const, frequencyDays: 7, amountBand: 10 }];
    expect(selectEffectiveCycleForAmount(effective, 10)).toBe(effective[0]);
    expect(selectEffectiveCycleForAmount(effective, 500)).toBeUndefined();
  });

  it("picks the closest band within tolerance across multiple bands", () => {
    const weekly = { source: "learned" as const, frequencyDays: 7, amountBand: 38.25 };
    const monthly = { source: "learned" as const, frequencyDays: 30, amountBand: 90 };
    const effective = [weekly, monthly];
    expect(selectEffectiveCycleForAmount(effective, 38.25)).toBe(weekly);
    expect(selectEffectiveCycleForAmount(effective, 90)).toBe(monthly);
    expect(selectEffectiveCycleForAmount(effective, 5000)).toBeUndefined();
  });

  // Regression: a zero-amount band (a free/trial recurrence) used to be
  // permanently excluded outright — `band.amountBand === 0` short-circuited
  // to `continue`, so no candidate, not even an exact 0, could ever select
  // it. A relative tolerance also can't apply against a zero denominator.
  it("matches a zero-amount band only against an exact-zero candidate, without dividing by zero", () => {
    const free = { source: "learned" as const, frequencyDays: 30, amountBand: 0 };
    const paid = { source: "learned" as const, frequencyDays: 30, amountBand: 20 };
    const effective = [free, paid];
    expect(selectEffectiveCycleForAmount(effective, 0)).toBe(free);
    expect(selectEffectiveCycleForAmount(effective, 20)).toBe(paid);
    expect(selectEffectiveCycleForAmount(effective, 5)).toBeUndefined();
  });
});
