/**
 * #504: line items whose amounts reconcile with the document total but whose
 * own VAT does not are flagged, not passed as sound.
 *
 * The live case: a two-ticket invoice (2 × 9,50 € = 19,00 €, 3,17 € VAT at
 * 20%) came back with the document's whole VAT on each row. The amounts
 * summed, so reconciliation passed, and every reader of the row VAT (UVA
 * derivation, the file view) saw 6,34 € of VAT on a 19,00 € invoice.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { reconcileLineItemsWithDocumentTotal } from "../extractionCore";

const DOC_TOTAL = 1900;
const PRINTED_BLOCK = [{ rate: 20, net: 1583, vat: 317, gross: 1900 }];

const ticket = (vatAmount: number) => ({
  description: "EINTRITTSKARTE, ERWACHSENE",
  vatPercent: 20,
  vatAmount,
  amount: 950,
});

describe("reconcileLineItemsWithDocumentTotal — row VAT (#504)", () => {
  it("flags the printed rate when every row carries the whole document VAT", () => {
    const r = reconcileLineItemsWithDocumentTotal([ticket(317), ticket(317)], DOC_TOTAL, PRINTED_BLOCK, 20);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([20]);
  });

  it("flags the whole document against its stated rate when no block was printed", () => {
    const r = reconcileLineItemsWithDocumentTotal([ticket(317), ticket(317)], DOC_TOTAL, null, 20);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([]);
  });

  it("passes rows whose VAT splits the document VAT", () => {
    const items = [ticket(158), ticket(159)];
    expect(reconcileLineItemsWithDocumentTotal(items, DOC_TOTAL, PRINTED_BLOCK, 20).unreconciled).toBe(false);
    expect(reconcileLineItemsWithDocumentTotal(items, DOC_TOTAL, null, 20).unreconciled).toBe(false);
  });

  it("absorbs per-row rounding across many rows", () => {
    // 12 × 1,99 € at 20%: each row's 0,3317 € rounds to 0,33; the document
    // prints 3,98 € of VAT on 23,88 €.
    const items = Array.from({ length: 12 }, () => ({
      description: "Artikel",
      vatPercent: 20,
      vatAmount: 33,
      amount: 199,
    }));
    const r = reconcileLineItemsWithDocumentTotal(items, 2388, null, 20);
    expect(r.unreconciled).toBe(false);
  });

  it("leaves rows alone that carry a rate but no VAT reading", () => {
    const r = reconcileLineItemsWithDocumentTotal([ticket(0), ticket(0)], DOC_TOTAL, PRINTED_BLOCK, 20);
    expect(r.unreconciled).toBe(false);
  });

  it("does not hold a mixed-rate itemisation against a single stated rate", () => {
    const items = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Wein", vatPercent: 20, vatAmount: 150, amount: 900 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(items, 4750, null, 20);
    expect(r.unreconciled).toBe(false);
  });

  it("checks each printed group on its own", () => {
    const block = [
      { rate: 10, net: 3500, vat: 350, gross: 3850 },
      { rate: 20, net: 750, vat: 150, gross: 900 },
    ];
    const items = [
      { description: "Pasta", vatPercent: 10, vatAmount: 350, amount: 3850 },
      { description: "Wein", vatPercent: 20, vatAmount: 500, amount: 900 },
    ];
    const r = reconcileLineItemsWithDocumentTotal(items, 4750, block, null);
    expect(r.unreconciled).toBe(true);
    expect(r.unreconciledRates).toEqual([20]);
  });
});
