/**
 * The retry eligibility rule and reset (fork #74), shared by the callable and
 * the retry_file_extraction tool.
 */

import { describe, it, expect, vi } from "vitest";

// Only the pure halves are under test here; the extraction run itself is
// covered by the tool handler tests and the selfhost characterization suite.
vi.mock("../extractionCore", () => ({ runExtraction: vi.fn() }));
vi.mock("firebase-admin/firestore", () => ({
  Timestamp: { now: () => new Date("2026-08-19T12:00:00Z") },
}));

const { canRetryExtraction, buildRetryResetUpdates } = await import("../retryExtractionOps");

describe("canRetryExtraction", () => {
  it("allows a file that errored", () => {
    expect(canRetryExtraction({ extractionComplete: true, extractionError: "boom" })).toBe(true);
  });

  it("allows a file the user reclassified either way", () => {
    expect(canRetryExtraction({ extractionComplete: true, isNotInvoice: true })).toBe(true);
    expect(canRetryExtraction({ extractionComplete: true, isNotInvoice: false })).toBe(true);
  });

  it("allows a file that never finished extracting", () => {
    expect(canRetryExtraction({ extractionComplete: false })).toBe(true);
  });

  it("refuses a clean extraction unless forced", () => {
    const clean = { extractionComplete: true, extractionError: null };
    expect(canRetryExtraction(clean)).toBe(false);
    expect(canRetryExtraction(clean, true)).toBe(true);
  });
});

describe("buildRetryResetUpdates", () => {
  it("re-arms extraction and both matching stages", () => {
    const updates = buildRetryResetUpdates({});
    expect(updates).toMatchObject({
      extractionComplete: false,
      extractionError: null,
      isNotInvoice: null,
      partnerMatchComplete: false,
      partnerSuggestions: [],
      transactionMatchComplete: false,
      transactionSuggestions: [],
    });
  });

  it("clears an automatic partner match but keeps a manual one", () => {
    expect(buildRetryResetUpdates({ partnerMatchedBy: "auto" })).toMatchObject({
      partnerId: null,
      partnerMatchedBy: null,
    });
    expect(buildRetryResetUpdates({ partnerMatchedBy: "manual" })).not.toHaveProperty("partnerId");
  });
});
