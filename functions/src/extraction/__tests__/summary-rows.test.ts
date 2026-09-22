/**
 * #252: the non-billable-line filter stops being English-only.
 *
 * It carried twelve patterns, all English — `total`, `subtotal`, `vat`. An
 * Austrian Beleg prints *Zwischensumme*, *Summe*, *Gesamt*, *MwSt.* and
 * *Trinkgeld*; none of them matched, so every summary row survived as a
 * billable line and doubled the sum. The file then failed reconciliation
 * and went to the review bucket with a perfectly good itemisation on it.
 *
 * Two rules, structural primary: a row whose amount is the document total
 * is a total row, a row whose amount is the sum of the rows above it is a
 * subtotal, and the German words are a cheap pre-filter for what that
 * cannot see. Two existing behaviours must survive both: a NEGATIVE row is
 * a printed discount and is never dropped, and the fallback that keeps the
 * raw rows when the filter would empty the list stays.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { reconcileLineItemsWithDocumentTotal } from "../extractionCore";

describe("summary rows on an Austrian Beleg", () => {
  /**
   * Gasthaus Beleg, card payment. Food at 10%, drinks at 20%, the three
   * summary rows the receipt prints, and `amount` as the VAT-bearing Summe
   * (the tip is its own field since #172).
   */
  const beleg = [
    { description: "2x Wiener Schnitzel", vatPercent: 10, vatAmount: 164, amount: 1800 },
    { description: "3x Bier 0,5l", vatPercent: 20, vatAmount: 75, amount: 450 },
    { description: "Zwischensumme", vatPercent: null, vatAmount: 0, amount: 2250 },
    { description: "Trinkgeld", vatPercent: null, vatAmount: 0, amount: 250 },
    { description: "Summe", vatPercent: null, vatAmount: 0, amount: 2500 },
  ];

  it("reconciles a Beleg carrying Zwischensumme, Trinkgeld and Summe rows", () => {
    const r = reconcileLineItemsWithDocumentTotal(beleg, 2250);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual([
      "2x Wiener Schnitzel",
      "3x Bier 0,5l",
    ]);
    // Both rates survive, which is what the UVA's line-item rung needs.
    expect(r.lineItems.map((i) => i.vatPercent).sort()).toEqual([10, 20]);
  });

  it("drops MwSt. and Gesamt rows on a single-item receipt", () => {
    const items = [
      { description: "Taxifahrt", vatPercent: 10, vatAmount: 91, amount: 1000 },
      { description: "MwSt. 10%", vatPercent: null, vatAmount: 0, amount: 91 },
      { description: "Gesamt", vatPercent: null, vatAmount: 0, amount: 1000 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1000);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual(["Taxifahrt"]);
  });

  it("keeps a row that merely BEGINS with a summary word", () => {
    const items = [
      { description: "Gesamtpaket Reinigung", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Summe", vatPercent: null, vatAmount: 0, amount: 1200 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1200);

    expect(r.lineItems.map((i) => i.description)).toEqual(["Gesamtpaket Reinigung"]);
  });

  it("drops a summary row printed in a language nobody enumerated", () => {
    // "Totale" is in no pattern list; the arithmetic identifies it anyway.
    const items = [
      { description: "Pizza Margherita", vatPercent: 10, vatAmount: 82, amount: 900 },
      { description: "Vino della casa", vatPercent: 20, vatAmount: 100, amount: 600 },
      { description: "Totale", vatPercent: null, vatAmount: 0, amount: 1500 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1500);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual([
      "Pizza Margherita",
      "Vino della casa",
    ]);
  });

  it("keeps a negative discount row, and the file still reconciles", () => {
    const items = [
      { description: "Bürostuhl", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Rabatt Aktion", vatPercent: 20, vatAmount: -33, amount: -200 },
      { description: "Summe", vatPercent: null, vatAmount: 0, amount: 1000 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1000);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual(["Bürostuhl", "Rabatt Aktion"]);
  });

  it("keeps a negative discount row while the structural pass drops the total", () => {
    // The other discount cases never reach the structural pass: their rows
    // already add up, so it returns before looking at anything. Here they do
    // not — "Totale" is in no pattern list — so the arithmetic runs with a
    // negative row in the list and has to leave it alone.
    const items = [
      { description: "Bürostuhl", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Rabatt Aktion", vatPercent: 20, vatAmount: -33, amount: -200 },
      { description: "Totale", vatPercent: null, vatAmount: 0, amount: 1000 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1000);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual(["Bürostuhl", "Rabatt Aktion"]);
  });

  it("keeps a discount row that happens to equal the sum above it", () => {
    // -20,00 is exactly what the two rows above add up to, which is the
    // arithmetic a subtotal has. A negative row is never a subtotal, so the
    // printed credit line survives and the file reconciles at 20,00.
    const items = [
      { description: "Toner", vatPercent: 20, vatAmount: 167, amount: 1000 },
      { description: "Papier", vatPercent: 20, vatAmount: 167, amount: 1000 },
      { description: "Aktionsnachlass", vatPercent: 20, vatAmount: -333, amount: -2000 },
      { description: "Nachdruck", vatPercent: 20, vatAmount: 333, amount: 2000 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 2000);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems).toHaveLength(4);
  });

  it("keeps the raw rows when the filter would empty the list", () => {
    // A receipt whose only itemisation IS its summary rows. Nothing is left
    // to bill, so the pre-#252 fallback hands the raw rows back.
    const items = [
      { description: "Summe", vatPercent: 20, vatAmount: 167, amount: 1000 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1000);

    expect(r.lineItems.map((i) => i.description)).toEqual(["Summe"]);
    expect(r.unreconciled).toBe(false);
  });

  it("leaves rows alone when dropping one would not close the sum", () => {
    // 100,00 is both a real row and the document total: a printed discount
    // the extraction missed. Dropping it would leave 5,00 against a 100,00
    // document — a worse reading, so nothing is dropped and the file is
    // flagged exactly as before.
    const items = [
      { description: "Schreibtisch", vatPercent: 20, vatAmount: 1667, amount: 10000 },
      { description: "Stiftebecher", vatPercent: 20, vatAmount: 83, amount: 500 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 10000);

    expect(r.lineItems).toHaveLength(2);
    expect(r.unreconciled).toBe(true);
  });
});
