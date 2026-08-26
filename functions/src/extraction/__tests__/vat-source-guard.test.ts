/**
 * Fork #137, the write policy half: re-extraction overwrites unconditionally,
 * so a pass that reads a document's VAT worse than the pass before it used to
 * replace the stronger record silently and leave no trace of the loss.
 */

import { describe, it, expect } from "vitest";

import { applyVatDowngradeGuard, vatSourceOf, VAT_FIELDS } from "../vatSourceGuard";

const ratedItems = [
  { description: "row", quantity: null, unitPrice: null, vatPercent: 20, vatAmount: 53000, amount: 318000 },
];

/** IV-26-1168.pdf as it stood before the D6 sweep. */
const strongRecord = {
  extractedAmount: 318000,
  extractedVatPercent: 20,
  extractedVatAmount: 53000,
  extractedLineItems: ratedItems,
  extractedRateGroups: null,
  lineItemsUnreconciled: false,
  lineItemsUnreconciledRates: null,
};

/** ...and as the sweep left it. */
const weakRecord = {
  extractedAmount: 318000,
  extractedVatPercent: 20,
  extractedVatAmount: null,
  extractedLineItems: [
    { description: "row", quantity: null, unitPrice: null, vatPercent: null, vatAmount: 0, amount: 265000 },
  ],
  extractedRateGroups: null,
  lineItemsUnreconciled: true,
  lineItemsUnreconciledRates: null,
};

describe("vatSourceOf", () => {
  it("ranks a printed rate-group block above everything else", () => {
    expect(vatSourceOf({ ...strongRecord, extractedRateGroups: [{ rate: 20, net: 265000, vat: 53000, gross: 318000 }] }))
      .toBe("rate-groups");
  });

  it("reads fully rated line items as the line-items step", () => {
    expect(vatSourceOf(strongRecord)).toBe("line-items");
  });

  it("falls back to the top-level VAT amount, then to the rate alone", () => {
    expect(vatSourceOf({ extractedVatPercent: 20, extractedVatAmount: 53000 })).toBe("top-level");
    expect(vatSourceOf({ extractedVatPercent: 20, extractedVatAmount: null })).toBe("rate-only");
    expect(vatSourceOf({})).toBe("none");
  });

  it("treats an unreconciled file with no printed block as yielding nothing", () => {
    // The UVA calculation drops such a transaction outright
    // ("amount-mismatch"), so the surviving top-level rate buys it nothing.
    expect(vatSourceOf(weakRecord)).toBe("none");
  });
});

describe("applyVatDowngradeGuard", () => {
  it("keeps the previous VAT fields when the new pass reads the document worse", () => {
    const updateData: Record<string, unknown> = { ...weakRecord, extractedPartner: "Neuer Name" };

    const report = applyVatDowngradeGuard(strongRecord, updateData);

    expect(report).toMatchObject({ from: "line-items", to: "none", downgraded: true, preserved: true });
    for (const field of VAT_FIELDS) {
      expect(updateData[field]).toEqual(strongRecord[field as keyof typeof strongRecord]);
    }
  });

  it("writes everything outside the VAT fields either way", () => {
    const updateData: Record<string, unknown> = { ...weakRecord, extractedPartner: "Neuer Name" };

    applyVatDowngradeGuard(strongRecord, updateData);

    expect(updateData.extractedPartner).toBe("Neuer Name");
  });

  it("lets a stronger or equal pass through untouched", () => {
    const updateData: Record<string, unknown> = {
      ...strongRecord,
      extractedRateGroups: [{ rate: 20, net: 265000, vat: 53000, gross: 318000 }],
    };

    const report = applyVatDowngradeGuard(strongRecord, updateData);

    expect(report).toMatchObject({ from: "line-items", to: "rate-groups", downgraded: false, preserved: false });
    expect(updateData.extractedVatAmount).toBe(53000);
  });

  it("records but does not repair a downgrade where the document total moved too", () => {
    // The older VAT fields describe a different reading of the document;
    // carrying them onto this total would build a record that never existed.
    const updateData: Record<string, unknown> = { ...weakRecord, extractedAmount: 750000 };

    const report = applyVatDowngradeGuard(strongRecord, updateData);

    expect(report).toMatchObject({ downgraded: true, preserved: false });
    expect(updateData.extractedVatAmount).toBeNull();
    expect(updateData.vatSourceDowngraded).toBe(true);
    expect(updateData.vatFieldsPreserved).toBe(false);
  });

  it("never blocks a not-an-invoice classification clearing the record", () => {
    const updateData: Record<string, unknown> = {
      isNotInvoice: true,
      extractedAmount: null,
      extractedVatPercent: null,
      extractedVatAmount: null,
      extractedLineItems: null,
      extractedRateGroups: null,
      lineItemsUnreconciled: false,
      lineItemsUnreconciledRates: null,
    };

    const report = applyVatDowngradeGuard(strongRecord, updateData);

    expect(report.preserved).toBe(false);
    expect(updateData.extractedLineItems).toBeNull();
  });

  it("leaves a first extraction alone", () => {
    const updateData: Record<string, unknown> = { ...strongRecord };

    const report = applyVatDowngradeGuard({}, updateData);

    expect(report).toMatchObject({ from: "none", downgraded: false, preserved: false });
  });
});
