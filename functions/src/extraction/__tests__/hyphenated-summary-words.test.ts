/**
 * #318: a hyphenated Steuer-, Netto- or Brutto- line item was dropped as a
 * summary row.
 *
 * The #252 word list anchors every leading word with `\b`, and a hyphen is a
 * word boundary like any other, so "Steuer- und Wirtschaftsberatung" — a
 * Steuerberater's own fee line — matched `^steuer\b` and was pre-filtered
 * out as a summary row. Same shape for "Netto-" and "Brutto-" compounds, and
 * for the pre-existing English `^tax\b`. A leading word now matches only
 * when it stands on its own, not when a hyphen joins it to what follows.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({ collection: () => ({}) }),
  Timestamp: { fromDate: (d: Date) => d, now: () => new Date() },
}));
vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({}) }));

import { reconcileLineItemsWithDocumentTotal } from "../extractionCore";

describe("hyphenated compounds survive the leading-word pre-filter", () => {
  it("keeps a Steuerberater fee line reading 'Steuer- und Wirtschaftsberatung'", () => {
    const items = [
      { description: "Steuer- und Wirtschaftsberatung", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Bürokosten", vatPercent: 20, vatAmount: 100, amount: 600 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1800);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual([
      "Steuer- und Wirtschaftsberatung",
      "Bürokosten",
    ]);
  });

  it("keeps a row opening with a 'Netto-' compound", () => {
    const items = [
      { description: "Netto-Honorar Beratung", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Materialkosten", vatPercent: 20, vatAmount: 100, amount: 600 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1800);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual([
      "Netto-Honorar Beratung",
      "Materialkosten",
    ]);
  });

  it("keeps a row opening with a 'Brutto-' compound", () => {
    const items = [
      { description: "Brutto-Zuschlag Lieferung", vatPercent: 20, vatAmount: 100, amount: 600 },
      { description: "Fahrtkosten", vatPercent: 20, vatAmount: 200, amount: 1200 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1800);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual([
      "Brutto-Zuschlag Lieferung",
      "Fahrtkosten",
    ]);
  });

  it("keeps a row opening with a 'Tax-' compound", () => {
    const items = [
      { description: "Tax-Deductible Advisory Fee", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Office Supplies", vatPercent: 20, vatAmount: 100, amount: 600 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1800);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual([
      "Tax-Deductible Advisory Fee",
      "Office Supplies",
    ]);
  });

  it("still drops 'MwSt. 20 %', 'Summe', 'Zwischensumme', 'Netto' and 'Brutto' standing alone", () => {
    const items = [
      { description: "Beratung", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "MwSt. 20 %", vatPercent: null, vatAmount: 0, amount: 200 },
      { description: "Zwischensumme", vatPercent: null, vatAmount: 0, amount: 1200 },
      { description: "Netto", vatPercent: null, vatAmount: 0, amount: 1000 },
      { description: "Brutto", vatPercent: null, vatAmount: 0, amount: 1200 },
      { description: "Summe", vatPercent: null, vatAmount: 0, amount: 1200 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1200);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual(["Beratung"]);
  });

  it("still drops 'Tax' standing alone", () => {
    const items = [
      { description: "Consulting", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Tax", vatPercent: null, vatAmount: 0, amount: 200 },
      { description: "Total", vatPercent: null, vatAmount: 0, amount: 1200 },
    ];

    const r = reconcileLineItemsWithDocumentTotal(items, 1200);

    expect(r.unreconciled).toBe(false);
    expect(r.lineItems.map((i) => i.description)).toEqual(["Consulting"]);
  });
});
