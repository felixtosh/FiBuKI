/**
 * Fork #147: a human correction to an extracted record. The rules that matter
 * are the ones a naive implementation gets wrong — omitted is not null, zero is
 * a real value, and a corrected total must survive the line items beside it.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  Timestamp: {
    fromDate: (d: Date) => ({ _seconds: Math.floor(d.getTime() / 1000), toDate: () => d }),
    now: () => ({ _seconds: 0 }),
  },
}));

import {
  buildExtractionCorrection,
  ExtractionCorrectionError,
} from "../extractionCorrectionOps";

describe("buildExtractionCorrection", () => {
  it("touches only the fields that were passed", () => {
    const { updates, changed } = buildExtractionCorrection({ vatPercent: 20 });

    expect(changed).toEqual(["vatPercent"]);
    expect(updates.extractedVatPercent).toBe(20);
    expect("extractedAmount" in updates).toBe(false);
    expect("extractedLineItems" in updates).toBe(false);
  });

  it("treats zero as a correction, not as unset", () => {
    // Dokument FIBU_20260109-8624: the VAT is read correctly and is not
    // claimable — 100% discount, EUR 0 due.
    const { updates } = buildExtractionCorrection({ vatPercent: 0, vatAmount: 0 });

    expect(updates.extractedVatPercent).toBe(0);
    expect(updates.extractedVatAmount).toBe(0);
  });

  it("clears a field on an explicit null", () => {
    const { updates } = buildExtractionCorrection({ vatAmount: null });

    expect(updates.extractedVatAmount).toBeNull();
  });

  it("does not re-derive the corrected total from the line items", () => {
    // IV-26-1170: a Schlussrechnung due 3180.00 whose items describe the full
    // 6360.00 scope. Consolidating would silently undo the correction.
    const { updates } = buildExtractionCorrection({
      amount: 318000,
      vatAmount: 53000,
      lineItems: [
        { description: "Grafikdesign", quantity: null, unitPrice: null, vatPercent: 20, vatAmount: 54000, amount: 324000 },
      ],
    });

    expect(updates.extractedAmount).toBe(318000);
    expect(updates.extractedVatAmount).toBe(53000);
  });

  it("makes the human the authority on any VAT-bearing correction", () => {
    const { updates } = buildExtractionCorrection({ amount: 318000 });

    expect(updates.lineItemsUnreconciled).toBe(false);
    expect(updates.lineItemsUnreconciledRates).toBeNull();
    expect(updates.extractedRateGroups).toBeNull();
    expect(updates.vatSourceDowngraded).toBe(false);
    expect(updates.vatFieldsPreserved).toBe(false);
  });

  it("leaves the VAT artefacts alone on a date-only correction", () => {
    const { updates } = buildExtractionCorrection({ date: "2026-05-30" });

    expect("extractedRateGroups" in updates).toBe(false);
    expect("lineItemsUnreconciled" in updates).toBe(false);
    expect(updates.extractedDate).toMatchObject({ _seconds: 1780099200 });
  });

  it("keeps a negative total — a credit note is legal", () => {
    const { updates } = buildExtractionCorrection({ amount: -579 });

    expect(updates.extractedAmount).toBe(-579);
  });

  it("normalises line items and defaults a missing VAT to zero", () => {
    const { updates } = buildExtractionCorrection({
      lineItems: [{ amount: 1000.4 } as never, { description: "  spaced  ", amount: 500, vatPercent: 200 } as never],
    });

    expect(updates.extractedLineItems).toEqual([
      { description: "Item 1", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 1000 },
      { description: "spaced", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 500 },
    ]);
  });

  it("refuses a correction that corrects nothing", () => {
    expect(() => buildExtractionCorrection({})).toThrow(ExtractionCorrectionError);
  });

  it("refuses a rate outside 0-100 and a date that is not a real day", () => {
    expect(() => buildExtractionCorrection({ vatPercent: 120 })).toThrow(/between 0 and 100/);
    expect(() => buildExtractionCorrection({ date: "2026-02-30" })).toThrow(/real calendar date/);
    expect(() => buildExtractionCorrection({ date: "30.05.2026" })).toThrow(/YYYY-MM-DD/);
  });

  it("refuses a non-numeric amount rather than storing NaN", () => {
    expect(() => buildExtractionCorrection({ amount: "3180" as never })).toThrow(/finite number of cents/);
  });
});
