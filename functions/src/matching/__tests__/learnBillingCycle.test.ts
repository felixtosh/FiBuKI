/**
 * Tests for learnBillingCycle interval detection algorithm.
 *
 * These test the pure helper functions extracted from the callable.
 * The actual callable tests would need Firestore mocks.
 */

import { describe, it, expect } from "vitest";

// ============================================================================
// We test the algorithm by re-implementing the pure functions here,
// since the callable wraps them with Firestore I/O.
// ============================================================================

/**
 * Find the most common interval within tolerance.
 * (Extracted from learnBillingCycle.ts for unit testing)
 */
function findModeInterval(
  intervals: number[],
  tolerance: number
): { modeInterval: number; count: number; matchingIntervals: number[] } | null {
  if (intervals.length === 0) return null;

  let bestMode = 0;
  let bestCount = 0;
  let bestMatching: number[] = [];

  const sorted = [...intervals].sort((a, b) => a - b);
  const tested = new Set<number>();

  for (const center of sorted) {
    const rounded = Math.round(center / 5) * 5 || center;
    if (tested.has(rounded)) continue;
    tested.add(rounded);

    const matching = intervals.filter(
      (i) => Math.abs(i - rounded) <= tolerance
    );

    if (matching.length > bestCount) {
      bestCount = matching.length;
      bestMode = rounded;
      bestMatching = matching;
    }
  }

  for (const period of [7, 14, 30, 60, 90, 180, 365]) {
    const matching = intervals.filter(
      (i) => Math.abs(i - period) <= tolerance
    );
    if (matching.length >= bestCount) {
      bestCount = matching.length;
      bestMode = period;
      bestMatching = matching;
    }
  }

  if (bestCount === 0) return null;
  return { modeInterval: bestMode, count: bestCount, matchingIntervals: bestMatching };
}

function computeMode(values: number[]): number {
  const freq = new Map<number, number>();
  for (const v of values) {
    freq.set(v, (freq.get(v) || 0) + 1);
  }
  let mode = values[0];
  let maxFreq = 0;
  for (const [val, count] of freq) {
    if (count > maxFreq) {
      maxFreq = count;
      mode = val;
    }
  }
  return mode;
}

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
// Billing cycle detection scenarios
// ============================================================================

describe("billing cycle detection scenarios", () => {
  /**
   * Simulate the full detection pipeline:
   * Given transaction dates → compute intervals → find mode → check thresholds
   */
  function detectCycle(dates: string[]): {
    frequencyDays: number;
    confidence: number;
    detected: boolean;
  } | null {
    if (dates.length < 3) return null;

    const sorted = dates.map((d) => new Date(d).getTime()).sort();
    const intervals: number[] = [];

    for (let i = 1; i < sorted.length; i++) {
      const days = Math.round((sorted[i] - sorted[i - 1]) / (1000 * 60 * 60 * 24));
      if (days > 0) intervals.push(days);
    }

    if (intervals.length < 2) return null;

    const result = findModeInterval(intervals, 5);
    if (!result) return null;

    const { modeInterval, count, matchingIntervals } = result;

    if (count < 3 || count / intervals.length < 0.5) {
      return { frequencyDays: modeInterval, confidence: 0, detected: false };
    }

    const consistencyRatio = count / intervals.length;
    const avgDeviation =
      matchingIntervals.reduce((sum, i) => sum + Math.abs(i - modeInterval), 0) /
      matchingIntervals.length;
    const confidence = Math.min(
      100,
      Math.round(consistencyRatio * 80 + Math.max(0, 20 - avgDeviation * 2))
    );

    return { frequencyDays: modeInterval, confidence, detected: true };
  }

  it("detects Netflix monthly subscription", () => {
    const dates = [
      "2024-01-15", "2024-02-15", "2024-03-15",
      "2024-04-15", "2024-05-15", "2024-06-15",
    ];
    const result = detectCycle(dates);
    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.frequencyDays).toBeCloseTo(30, -1);
    expect(result!.confidence).toBeGreaterThan(50);
  });

  it("detects Telekom with slight date variation", () => {
    const dates = [
      "2024-01-03", "2024-02-04", "2024-03-03",
      "2024-04-03", "2024-05-02", "2024-06-04",
    ];
    const result = detectCycle(dates);
    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.frequencyDays).toBeCloseTo(30, -1);
  });

  it("detects quarterly insurance payments", () => {
    const dates = [
      "2024-01-15", "2024-04-15", "2024-07-15", "2024-10-15",
    ];
    const result = detectCycle(dates);
    expect(result).not.toBeNull();
    expect(result!.detected).toBe(true);
    expect(result!.frequencyDays).toBeCloseTo(90, -1);
  });

  it("fails to detect with too few transactions", () => {
    const dates = ["2024-01-15", "2024-02-15"];
    expect(detectCycle(dates)).toBeNull();
  });

  it("fails to detect with irregular intervals", () => {
    const dates = [
      "2024-01-01", "2024-01-15", "2024-03-20",
      "2024-04-01", "2024-07-10", "2024-09-05",
    ];
    const result = detectCycle(dates);
    // May detect something but with low confidence
    if (result) {
      expect(result.detected).toBe(false);
    }
  });
});
