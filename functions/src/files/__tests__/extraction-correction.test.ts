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
    // A discounted document: the VAT is read correctly and is not
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
    // A Schlussrechnung due 3180.00 whose items describe the full
    // 6360.00 scope. Consolidating would silently undo the correction.
    const { updates } = buildExtractionCorrection({
      amount: 318000,
      vatAmount: 53000,
      lineItems: [
        { description: "Grafikdesign", vatPercent: 20, vatAmount: 54000, amount: 324000 },
      ],
    });

    expect(updates.extractedAmount).toBe(318000);
    expect(updates.extractedVatAmount).toBe(53000);
    // #203: the disagreement is deliberate here, and it is SURFACED — the
    // items stay flagged so VAT derivation refuses them rather than summing a
    // scope the person just said is not what is due.
    expect(updates.lineItemsUnreconciled).toBe(true);
  });

  it("makes the human the authority on any VAT-bearing correction", () => {
    const { updates } = buildExtractionCorrection({ amount: 318000 });

    expect(updates.lineItemsUnreconciled).toBe(false);
    expect(updates.lineItemsUnreconciledRates).toBeNull();
    expect(updates.extractedRateGroups).toBeNull();
    expect(updates.vatSourceDowngraded).toBe(false);
    expect(updates.vatFieldsPreserved).toBe(false);
  });

  // #203: the block above used to hard-code `lineItemsUnreconciled = false`,
  // which disarmed the UVA's amount-mismatch guard on exactly the files it
  // existed for — an extractor that skipped a printed discount row leaves
  // items summing to MORE than the document, and one hand correction turned
  // that from a refused file into silently over-claimed VAT. The flag is now
  // re-derived against the record as it will be after the write.
  describe("re-deriving the reconciliation flag (#203)", () => {
    // Three captured goods rows, gross 90.00 — but the document prints 81.00,
    // because its postage (0.00) and discount (−9.00) rows were not captured.
    const capturedRows = [
      { description: "goods A", vatPercent: 20, vatAmount: 500, amount: 3000 },
      { description: "goods B", vatPercent: 20, vatAmount: 750, amount: 4500 },
      { description: "goods C", vatPercent: 20, vatAmount: 250, amount: 1500 },
    ];

    it("keeps the file flagged when the corrected items still contradict the total", () => {
      const { updates } = buildExtractionCorrection(
        { lineItems: capturedRows },
        { extractedAmount: 8100 }
      );

      expect(updates.lineItemsUnreconciled).toBe(true);
      expect(updates.extractedRateGroups).toBeNull();
    });

    it("un-flags a file once the person completes the itemisation", () => {
      const { updates } = buildExtractionCorrection(
        {
          lineItems: [
            ...capturedRows,
            { description: "postage", vatPercent: 20, vatAmount: 0, amount: 0 },
            { description: "discount 10%", vatPercent: 20, vatAmount: -150, amount: -900 },
          ],
        },
        { extractedAmount: 8100, lineItemsUnreconciled: true }
      );

      expect(updates.lineItemsUnreconciled).toBe(false);
      expect(updates.lineItemsUnreconciledRates).toBeNull();
    });

    it("judges an amount correction against the items already stored", () => {
      const stored = { extractedLineItems: capturedRows };

      const agrees = buildExtractionCorrection({ amount: 9000 }, stored);
      expect(agrees.updates.lineItemsUnreconciled).toBe(false);

      const disagrees = buildExtractionCorrection({ amount: 8100 }, stored);
      expect(disagrees.updates.lineItemsUnreconciled).toBe(true);
    });

    it("clearing the itemisation clears the flag — nothing is left to contradict", () => {
      const { updates } = buildExtractionCorrection(
        { lineItems: null },
        { extractedAmount: 8100, extractedLineItems: capturedRows, lineItemsUnreconciled: true }
      );

      expect(updates.extractedLineItems).toBeNull();
      expect(updates.lineItemsUnreconciled).toBe(false);
    });
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
      { description: "Item 1", vatPercent: null, vatAmount: 0, amount: 1000 },
      { description: "spaced", vatPercent: null, vatAmount: 0, amount: 500 },
    ]);
  });

  // #217: the tip the document never printed. The failure this guards against
  // is quiet — a VAT base short by the tip under-claims the return.
  describe("a hand-set Trinkgeld (#217)", () => {
    it("stores the tip beside the total without touching it", () => {
      const { updates, changed } = buildExtractionCorrection({ tipAmount: 320 });

      expect(changed).toEqual(["tipAmount"]);
      expect(updates.extractedTipAmount).toBe(320);
      expect("extractedAmount" in updates).toBe(false);
    });

    it("does not subtract the tip from a total the document set beside it", () => {
      // A § 11-complete restaurant invoice over 50,80 that printed no tip; the
      // card was charged 54,00. The invoice total already IS the VAT-bearing
      // figure, so the correction leaves it exactly where it was.
      const { updates } = buildExtractionCorrection(
        { tipAmount: 320 },
        { extractedAmount: 5080, extractedVatAmount: 555 }
      );

      expect("extractedAmount" in updates).toBe(false);
      expect("extractedVatAmount" in updates).toBe(false);
    });

    it("leaves the printed rate groups standing — a tip is outside VAT", () => {
      // Listing tipAmount as VAT-bearing would clear the block that proves what
      // the total contains, which is the evidence the printed-tip rule reads.
      const { updates } = buildExtractionCorrection({ tipAmount: 320 });

      expect("extractedRateGroups" in updates).toBe(false);
      expect("lineItemsUnreconciled" in updates).toBe(false);
      expect("vatSourceDowngraded" in updates).toBe(false);
    });

    it("stamps it, so re-extraction refuses the file rather than dropping it", () => {
      const { updates } = buildExtractionCorrection({ tipAmount: 320 });

      expect(Object.keys(updates.extractionCorrectedFields as object)).toEqual(["tipAmount"]);
    });

    it("reads zero and null as the same answer: no tip", () => {
      expect(buildExtractionCorrection({ tipAmount: null }).updates.extractedTipAmount).toBeNull();
      expect(buildExtractionCorrection({ tipAmount: 0 }).updates.extractedTipAmount).toBeNull();
    });

    it("refuses a negative tip instead of storing one nothing reads", () => {
      expect(() => buildExtractionCorrection({ tipAmount: -320 })).toThrow(/must not be negative/);
      expect(() => buildExtractionCorrection({ tipAmount: "3,20" as never })).toThrow(
        /finite number of cents/
      );
    });
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

  // #184: without this the correction leaves no trace of itself and the next
  // re-extraction sweep discards it silently.
  it("stamps the corrected fields as human-set, merging with earlier corrections", () => {
    const previous = { extractionCorrectedFields: { date: { _seconds: 5 } } };

    const { updates } = buildExtractionCorrection({ amount: 318000, vatAmount: 53000 }, previous);

    expect(updates.extractionCorrectedFields).toMatchObject({
      date: { _seconds: 5 },
      amount: { _seconds: 0 },
      vatAmount: { _seconds: 0 },
    });
    expect(updates.extractionCorrectedAt).toEqual({ _seconds: 0 });
  });

  it("stamps a date-only correction too, VAT-bearing or not", () => {
    const { updates } = buildExtractionCorrection({ date: "2026-05-30" });

    expect(Object.keys(updates.extractionCorrectedFields as object)).toEqual(["date"]);
  });
});
