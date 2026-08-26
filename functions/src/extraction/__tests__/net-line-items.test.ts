/**
 * Fork #137: line items a document printed NET, on a document whose total is
 * gross. The D6 re-extraction sweep of 2026-08-19 lost derivable VAT on 29 of
 * 325 files this way — every one of them an outgoing document whose rows came
 * back with no rate at all, so the row sum contradicted the gross total, the
 * file was flagged, and its VAT went to null with nothing to replace it.
 *
 * Figures below are the real corpus records the sweep produced.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { reconcileLineItemsWithDocumentTotal } from "../extractionCore";

const item = (amount: number, vatPercent: number | null = null, vatAmount = 0) => ({
  description: "row",
  quantity: null,
  unitPrice: null,
  vatPercent,
  vatAmount,
  amount,
});

describe("net line items on a gross document total (fork #137)", () => {
  it("stamps the document's rate on unrated rows when grossing up hits the total", () => {
    // IV-26-1168.pdf: one net row of 2650.00 against a document total of
    // 3180.00, the document itself stating 20%.
    const r = reconcileLineItemsWithDocumentTotal([item(265000)], 318000, null, 20);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems).toEqual([
      { description: "row", quantity: null, unitPrice: null, vatPercent: 20, vatAmount: 53000, amount: 318000 },
    ]);
  });

  it("makes the converted rows sum to the document total exactly", () => {
    // Rounding residual: three rows at 13% would each round down.
    const rows = [item(3333), item(3333), item(3334)];
    const total = Math.round(10000 * 1.13);

    const r = reconcileLineItemsWithDocumentTotal(rows, total, null, 13);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.reduce((s, i) => s + i.amount, 0)).toBe(total);
    expect(r.lineItems.reduce((s, i) => s + i.vatAmount, 0)).toBe(total - 10000);
  });

  it("converts rated rows that carry their VAT on top of a net amount", () => {
    const rows = [item(50000, 20, 10000), item(20000, 10, 2000)];

    const r = reconcileLineItemsWithDocumentTotal(rows, 82000, null, null);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.amount)).toEqual([60000, 22000]);
    expect(r.lineItems.map((i) => i.vatPercent)).toEqual([20, 10]);
  });

  it("re-reads a rated row whose VAT was taken as already inside the amount", () => {
    // The row is net 2650.00 at 20%, but vatAmount came back as the gross
    // reading (441.67). Only the net reading closes on 3180.00.
    const r = reconcileLineItemsWithDocumentTotal([item(265000, 20, 44167)], 318000, null, 20);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems[0]).toMatchObject({ amount: 318000, vatAmount: 53000, vatPercent: 20 });
  });

  it("leaves rows that already reconcile as gross untouched", () => {
    const rows = [item(318000, 20, 53000)];

    const r = reconcileLineItemsWithDocumentTotal(rows, 318000, null, 20);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems).toEqual(rows);
  });

  it("still flags rows the document rate cannot explain", () => {
    // IV-26-1170.pdf: rows summing to 5300.00 against a 3180.00 total. No
    // reading of net-versus-gross closes that, so it stays a human's problem.
    const r = reconcileLineItemsWithDocumentTotal([item(530000)], 318000, null, 20);

    expect(r.unreconciled).toBe(true);
    expect(r.lineItems[0].amount).toBe(530000);
  });

  it("does not invent a rate the document never printed", () => {
    // IV-26-1171.pdf: 2050.00 of rows against 2460.00, which happens to be
    // exactly 20% — but the document states no rate, so nothing is stamped.
    const r = reconcileLineItemsWithDocumentTotal([item(205000)], 246000, null, null);

    expect(r.unreconciled).toBe(true);
    expect(r.lineItems[0].vatPercent).toBeNull();
  });

  it("leaves a mix of rated and unrated rows to the ordinary flagging path", () => {
    const r = reconcileLineItemsWithDocumentTotal([item(50000, 20, 10000), item(20000)], 82000, null, 20);

    expect(r.unreconciled).toBe(true);
  });

  it("defers to a validated printed rate-group block", () => {
    // A block is an independent reading of the document and outranks any
    // net/gross inference we could make from the rows.
    const block = [{ rate: 20, net: 265000, vat: 53000, gross: 318000 }];

    const r = reconcileLineItemsWithDocumentTotal([item(265000)], 318000, block, 20);

    expect(r.rateGroups).toEqual(block);
    expect(r.lineItems[0].amount).toBe(265000);
  });
});
