/**
 * Fork #67 (spec §6 items 2-3): the receipt's own printed per-rate VAT
 * summary block.
 *
 * Two behaviors are pinned here:
 *  - the block is validated before anything trusts it — an unverifiable
 *    transcription is worth less than no block at all, because it would
 *    silently become the VAT truth for the whole document;
 *  - once validated, it localises a reconciliation failure to the rate
 *    group OCR actually damaged, instead of condemning the document. The
 *    untouched groups keep their §11-sufficient printed totals.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import {
  reconcileLineItemsWithDocumentTotal,
  validateRateGroups,
} from "../extractionCore";

// Sapori d'Italia shape: food at 10%, drinks at 20%, 47,50 € total.
const PRINTED_BLOCK = [
  { rate: 10, net: 3500, vat: 350, gross: 3850 },
  { rate: 20, net: 750, vat: 150, gross: 900 },
];
const DOC_TOTAL = 4750;

const grossItems = [
  { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
  { description: "Wein", vatPercent: 20, vatAmount: 150, amount: 900 },
];

describe("validateRateGroups", () => {
  it("accepts a self-consistent block that sums to the document total", () => {
    expect(validateRateGroups(PRINTED_BLOCK, DOC_TOTAL)).toEqual(PRINTED_BLOCK);
  });

  it("rejects a row whose VAT contradicts its own printed rate", () => {
    // net + vat = gross holds, but 20% of 750 is 150, not 900 — the classic
    // column-read-off-the-wrong-row failure.
    const bad = [{ rate: 20, net: 750, vat: 900, gross: 1650 }];
    expect(validateRateGroups(bad, 1650)).toBeNull();
  });

  it("rejects a row where net + vat does not make gross", () => {
    const bad = [{ rate: 20, net: 750, vat: 150, gross: 1200 }];
    expect(validateRateGroups(bad, 1200)).toBeNull();
  });

  it("rejects a block that does not sum to the document total", () => {
    expect(validateRateGroups(PRINTED_BLOCK, 9999)).toBeNull();
  });

  it("rejects negative or empty figures", () => {
    expect(validateRateGroups([{ rate: 20, net: -100, vat: -20, gross: -120 }], 120)).toBeNull();
    expect(validateRateGroups([{ rate: 20, net: 0, vat: 0, gross: 0 }], 0)).toBeNull();
  });

  it("returns null for an absent or empty block", () => {
    expect(validateRateGroups(null, DOC_TOTAL)).toBeNull();
    expect(validateRateGroups([], DOC_TOTAL)).toBeNull();
  });

  it("accepts a block when the document total is unknown", () => {
    expect(validateRateGroups(PRINTED_BLOCK, null)).toEqual(PRINTED_BLOCK);
  });
});

describe("reconcileLineItemsWithDocumentTotal — printed rate groups", () => {
  it("carries the validated block through on a clean reconciliation", () => {
    const r = reconcileLineItemsWithDocumentTotal(grossItems, DOC_TOTAL, PRINTED_BLOCK);
    expect(r.unreconciled).toBe(false);
    expect(r.unreconciledRates).toEqual([]);
    expect(r.rateGroups).toEqual(PRINTED_BLOCK);
  });

  it("flags only the rate group OCR damaged", () => {
    // 9,00 read as 90,00: the 20% group is wrecked, the 10% group is not.
    const noisy = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Wein", vatPercent: 20, vatAmount: 150, amount: 9000 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(noisy, DOC_TOTAL, PRINTED_BLOCK);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([20]);
    // the items survive for human repair, and the printed block survives too
    expect(r.lineItems).toHaveLength(2);
    expect(r.rateGroups).toEqual(PRINTED_BLOCK);
  });

  it("reconciles when groups disagree on net-vs-gross but each one matches", () => {
    // The 10% items are gross, the 20% items are net. A single global
    // net-or-gross decision misses the document total; per-group testing
    // clears both — the case spec §6 item 2 exists for.
    const mixed = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Wein", vatPercent: 20, vatAmount: 150, amount: 750 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(mixed, DOC_TOTAL, PRINTED_BLOCK);
    expect(r.unreconciled).toBe(false);
    expect(r.unreconciledRates).toEqual([]);
  });

  it("falls back to whole-document flagging when an item carries no rate", () => {
    const rateless = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "?", vatPercent: null, vatAmount: 0, amount: 9000 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(rateless, DOC_TOTAL, PRINTED_BLOCK);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([]);
  });

  it("falls back to whole-document flagging when an item sits at a rate the block never mentions", () => {
    // Structural disagreement between the two readings, not localised noise.
    const strayRate = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Kunst", vatPercent: 13, vatAmount: 150, amount: 9000 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(strayRate, DOC_TOTAL, PRINTED_BLOCK);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([]);
  });

  it("keeps pre-#67 whole-document behavior when the document prints no block", () => {
    const noisy = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Wein", vatPercent: 20, vatAmount: 150, amount: 9000 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(noisy, DOC_TOTAL);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([]);
    expect(r.rateGroups).toBeNull();
  });

  it("discards an invalid block rather than localising against it", () => {
    const noisy = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Wein", vatPercent: 20, vatAmount: 150, amount: 9000 },
    ];
    const badBlock = [{ rate: 20, net: 750, vat: 900, gross: 1650 }];
    const r = reconcileLineItemsWithDocumentTotal(noisy, DOC_TOTAL, badBlock);
    expect(r.rateGroups).toBeNull();
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([]);
  });

  it("returns the validated block even with no line items at all", () => {
    const r = reconcileLineItemsWithDocumentTotal([], DOC_TOTAL, PRINTED_BLOCK);
    expect(r.lineItems).toEqual([]);
    expect(r.unreconciled).toBe(false);
    expect(r.rateGroups).toEqual(PRINTED_BLOCK);
  });
});
