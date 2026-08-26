/**
 * Fork #64 (spec §6): reconciliation failure must KEEP the extracted line
 * items and flag the file, never destroy them with a single fallback line
 * at the document rate — that fallback collapsed exactly the multi-rate
 * receipts the UVA calculation needs.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { reconcileLineItemsWithDocumentTotal } from "../extractionCore";

const multiRateItems = [
  { description: "food", vatPercent: 10, vatAmount: 350, amount: 3850 },
  { description: "drinks", vatPercent: 20, vatAmount: 150, amount: 900 },
];

describe("reconcileLineItemsWithDocumentTotal", () => {
  it("passes reconciled multi-rate items through unflagged", () => {
    const r = reconcileLineItemsWithDocumentTotal(multiRateItems, 4750);
    expect(r.unreconciled).toBe(false);
    expect(r.lineItems).toHaveLength(2);
  });

  it("keeps and flags items when the sum misses the document total", () => {
    // OCR noise case: document total says 5750, items sum to 4750
    const r = reconcileLineItemsWithDocumentTotal(multiRateItems, 5750);
    expect(r.unreconciled).toBe(true);
    // the multi-rate structure survives — no single fallback line
    expect(r.lineItems).toHaveLength(2);
    expect(r.lineItems.map((li) => li.vatPercent).sort()).toEqual([10, 20]);
  });

  it("does not flag when no document total exists", () => {
    const r = reconcileLineItemsWithDocumentTotal(multiRateItems, null);
    expect(r.unreconciled).toBe(false);
    expect(r.lineItems).toHaveLength(2);
  });
});
