/**
 * #246: a File whose Extraction has not finished yet must not be read as a
 * File that explains 0,00. Otherwise a freshly dropped File makes a documented
 * Transaction look wholly open. The helper says how many Files it could not
 * count yet, so the detail panels can say so, and the scorers read the same
 * figure through documentedAmountsOf.
 */

import { describe, it, expect } from "vitest";
import {
  documentedAmountOf,
  isExtractionPending,
  summarizeConnectedFiles,
} from "../coverage";

describe("isExtractionPending", () => {
  it("is pending until the Extraction completes, unless the File is not an invoice", () => {
    expect(isExtractionPending({ extractionComplete: false })).toBe(true);
    expect(isExtractionPending({})).toBe(true);
    expect(isExtractionPending({ extractionComplete: true })).toBe(false);
    expect(isExtractionPending({ extractionComplete: false, isNotInvoice: true })).toBe(false);
  });
});

describe("summarizeConnectedFiles", () => {
  it("counts a File still being read apart, instead of as 0,00", () => {
    const summary = summarizeConnectedFiles([
      { payment: 6000, extractionPending: false },
      { payment: null, extractionPending: true },
    ]);
    expect(summary).toEqual({ documentedAmount: 6000, pendingCount: 1 });
  });

  it("reports a Transaction whose only File is still being read as pending, not undocumented", () => {
    expect(summarizeConnectedFiles([{ payment: null, extractionPending: true }])).toEqual({
      documentedAmount: 0,
      pendingCount: 1,
    });
  });

  it("sums finished Files exactly as documentedAmountOf does", () => {
    const files = [
      { payment: 6000, extractionPending: false },
      { payment: -4000, extractionPending: false },
      { payment: null, extractionPending: false },
    ];
    expect(summarizeConnectedFiles(files).documentedAmount).toBe(
      documentedAmountOf(files.map((f) => f.payment))
    );
    expect(summarizeConnectedFiles(files).pendingCount).toBe(0);
  });

  it("counts a File that already carries an amount, so the scorers' sums do not move", () => {
    expect(summarizeConnectedFiles([{ payment: 9999, extractionPending: true }])).toEqual({
      documentedAmount: 9999,
      pendingCount: 0,
    });
  });
});
