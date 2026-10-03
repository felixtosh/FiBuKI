/**
 * Corrections in the UVA (#564, ADR-0010): a refund reverses what its
 * original did, on the original's side, in the period the money moves.
 *
 * Tested at the pure calculation, the way the period run hands it a
 * Transaction: the link, the original's claim and the earlier refunds are
 * already resolved on `correction`.
 */

import { describe, it, expect } from "vitest";
import { calculateUva } from "./calculateUva";
import { bookingSide, correctionAmounts, priorCorrectedOf } from "./correction";
import type { UvaCorrection, UvaPeriod, UvaTransaction } from "./types";

const Q1: UvaPeriod = { year: 2026, period: 1, type: "quarterly" };
const Q2: UvaPeriod = { year: 2026, period: 2, type: "quarterly" };

const kz = (r: ReturnType<typeof calculateUva>, code: string) => r.kennzahlen[code]?.value ?? 0;

/** A 120,00 purchase at 20% that claimed its 20,00 of Vorsteuer. */
const PURCHASE_20 = {
  fileId: "f-original",
  paidByTransactionIds: ["t-purchase"],
  gross: 12000,
  claimed: [{ rate: 20, net: 10000, vat: 2000 }],
};

function linked(
  kind: "purchase" | "sale",
  original = PURCHASE_20,
  extra: Partial<Extract<UvaCorrection, { status: "linked" }>> = {}
): UvaCorrection {
  return { status: "linked", kind, basis: "link", original, priorCorrected: [], ...extra };
}

/** A supplier's credit note, printed negative, on the money-in line. */
const creditNote = (gross: number) => ({
  id: "f-credit-note",
  totalGross: -gross,
  vatPercent: 20,
  vatAmount: -Math.round((gross * 20) / 120),
});

function refund(id: string, date: string, amount: number, correction: UvaCorrection): UvaTransaction {
  return { id, date, amount, partnerName: "Amazon", files: [creditNote(Math.abs(amount))], correction };
}

describe("bookingSide", () => {
  it("decides by sign when no File says otherwise", () => {
    expect(bookingSide({ amount: 100 })).toBe("sale");
    expect(bookingSide({ amount: -100 })).toBe("purchase");
  });

  it("books a linked correction on its original's side, whatever the sign", () => {
    expect(bookingSide({ amount: 100, correction: linked("purchase") })).toBe("purchase-correction");
    expect(bookingSide({ amount: -100, correction: linked("sale") })).toBe("sale-correction");
  });

  it("keeps an unlinked correction on the sign until it is linked", () => {
    const unlinked: UvaCorrection = { status: "unlinked", reason: "no-link", fileIds: ["f"] };
    expect(bookingSide({ amount: 100, correction: unlinked })).toBe("sale");
    expect(bookingSide({ amount: -100, correction: unlinked })).toBe("purchase");
  });
});

describe("a purchase refund", () => {
  it("reduces Vorsteuer in KZ 067, negative, and never touches revenue or KZ 060", () => {
    const r = calculateUva({ period: Q1, transactions: [refund("t-refund", "2026-02-10", 3000, linked("purchase"))] });
    expect(kz(r, "067")).toBe(-500);
    expect(r.kennzahlen["060"]).toBeUndefined();
    expect(r.kennzahlen["000"]).toBeUndefined();
    expect(r.kennzahlen["022"]).toBeUndefined();
    expect(r.totalOutputVat).toBe(0);
    expect(r.totalInputVat).toBe(-500);
    // Giving Vorsteuer back raises what is payable.
    expect(r.balance).toBe(500);
    expect(kz(r, "095")).toBe(500);
  });

  it("leaves KZ 060 with only this period's claims beside it", () => {
    const purchase: UvaTransaction = {
      id: "t-purchase",
      date: "2026-01-05",
      amount: -12000,
      files: [{ id: "f-original", totalGross: 12000, vatPercent: 20, vatAmount: 2000 }],
    };
    const r = calculateUva({
      period: Q1,
      transactions: [purchase, refund("t-refund", "2026-02-10", 3000, linked("purchase"))],
    });
    expect(kz(r, "060")).toBe(2000);
    expect(kz(r, "067")).toBe(-500);
    expect(r.balance).toBe(-1500);
  });

  it("does not read the credit note's printed figures as revenue", () => {
    // Before #564 this line booked as negative revenue: KZ 022 -25,00.
    const r = calculateUva({ period: Q1, transactions: [refund("t-refund", "2026-02-10", 3000, linked("purchase"))] });
    expect(r.outputVatByRate).toEqual([]);
  });

  it("corrects a mixed-rate original per rate, at the original's split", () => {
    const original = {
      ...PURCHASE_20,
      gross: 23300, // 120,00 at 20% + 113,00 at 13%
      claimed: [
        { rate: 20, net: 10000, vat: 2000 },
        { rate: 13, net: 10000, vat: 1300 },
      ],
    };
    const r = calculateUva({
      period: Q1,
      transactions: [refund("t-refund", "2026-02-10", 11650, linked("purchase", original))],
    });
    expect(r.corrections[0].corrected).toEqual([
      { rate: 20, net: 5000, vat: 1000 },
      { rate: 13, net: 5000, vat: 650 },
    ]);
    expect(kz(r, "067")).toBe(-1650);
  });

  it("corrects nothing when the original claimed nothing (0%, foreign VAT, non-claimable)", () => {
    const zero = { ...PURCHASE_20, gross: 1428, claimed: [{ rate: 0, net: 1428, vat: 0 }] };
    const r = calculateUva({
      period: Q1,
      transactions: [refund("t-refund-0", "2026-03-01", 1428, linked("purchase", zero))],
    });
    expect(r.kennzahlen["011"]).toBeUndefined();
    expect(r.kennzahlen["000"]).toBeUndefined();
    expect(r.kennzahlen["067"]).toBeUndefined();
    expect(r.balance).toBe(0);
    expect(r.corrections[0]).toMatchObject({ status: "linked", corrected: [], excessVat: 0 });
  });

  it("books each partial refund in its own quarter, the second capped by the first", () => {
    const first = refund("t-r1", "2026-03-20", 6000, linked("purchase"));
    const second = refund(
      "t-r2",
      "2026-05-04",
      6000,
      linked("purchase", PURCHASE_20, { priorCorrected: priorCorrectedOf([6000], PURCHASE_20.claimed, 12000) })
    );
    const q1 = calculateUva({ period: Q1, transactions: [first, second] });
    const q2 = calculateUva({ period: Q2, transactions: [first, second] });
    expect(kz(q1, "067")).toBe(-1000);
    expect(kz(q2, "067")).toBe(-1000);
    expect(q2.corrections[0].priorCorrected).toEqual([{ rate: 20, net: 5000, vat: 1000 }]);
  });

  it("caps all refunds of one original at what it claimed, and reports the excess", () => {
    const over = refund(
      "t-r3",
      "2026-02-10",
      6000,
      linked("purchase", PURCHASE_20, { priorCorrected: [{ rate: 20, net: 8000, vat: 1600 }] })
    );
    const r = calculateUva({ period: Q1, transactions: [over] });
    expect(kz(r, "067")).toBe(-400);
    expect(r.corrections[0].excessVat).toBe(600);
  });

  it("flags a credit note whose printed VAT disagrees with the computed correction", () => {
    const ok = refund("t-ok", "2026-02-10", 3000, linked("purchase", PURCHASE_20, { printedVat: 500 }));
    const off = refund("t-off", "2026-02-11", 3000, linked("purchase", PURCHASE_20, { printedVat: 300 }));
    const r = calculateUva({ period: Q1, transactions: [ok, off] });
    expect(r.corrections.map((c) => c.printedVatMismatch)).toEqual([false, true]);
  });

  it("traces the correction to the original File as well as the line's own", () => {
    const r = calculateUva({ period: Q1, transactions: [refund("t-refund", "2026-02-10", 3000, linked("purchase"))] });
    expect(r.derivations[0]).toMatchObject({
      step: "purchase-correction",
      inputVat: -500,
      fileIds: ["f-credit-note", "f-original"],
    });
  });
});

describe("the User's refund to a customer", () => {
  const SALE_20 = {
    fileId: "f-invoice",
    paidByTransactionIds: ["t-sale"],
    gross: 12000,
    claimed: [{ rate: 20, net: 10000, vat: 2000 }],
  };
  const payback = (amount: number): UvaTransaction => ({
    id: "t-payback",
    date: "2026-02-20",
    amount: -amount,
    files: [{ id: "f-correction", totalGross: -amount, vatPercent: 20, vatAmount: -Math.round((amount * 20) / 120) }],
    correction: linked("sale", SALE_20),
  });

  it("lowers KZ 000 and the rate field and never claims Vorsteuer", () => {
    const sale: UvaTransaction = {
      id: "t-sale",
      date: "2026-01-10",
      amount: 24000,
      files: [{ id: "f-other", totalGross: 24000, vatPercent: 20, vatAmount: 4000 }],
    };
    const r = calculateUva({ period: Q1, transactions: [sale, payback(6000)] });
    expect(kz(r, "000")).toBe(15000);
    expect(kz(r, "022")).toBe(15000);
    expect(r.kennzahlen["060"]).toBeUndefined();
    expect(r.totalInputVat).toBe(0);
    expect(r.totalOutputVat).toBe(3000);
    expect(r.balance).toBe(3000);
  });

  it("floors a rate field that would go negative at 0 and moves the tax to KZ 090", () => {
    const r = calculateUva({ period: Q1, transactions: [payback(6000)] });
    expect(kz(r, "022")).toBe(0);
    expect(kz(r, "000")).toBe(0);
    expect(kz(r, "090")).toBe(-1000);
    expect(r.balance).toBe(-1000);
    expect(kz(r, "095")).toBe(-1000);
  });
});

describe("an unlinked correction", () => {
  const unlinked: UvaCorrection = { status: "unlinked", reason: "no-link", fileIds: ["f-credit-note"] };

  it("keeps money in at the defaulted 20% revenue, never the credit note's negative figures", () => {
    const r = calculateUva({ period: Q1, transactions: [refund("t-u", "2026-02-10", 3000, unlinked)] });
    expect(kz(r, "022")).toBe(2500);
    expect(r.totalOutputVat).toBe(500);
    expect(r.unresolved[0]).toMatchObject({ reason: "correction-unlinked", defaultedOutputVat: 500 });
    expect(r.corrections[0]).toMatchObject({ status: "unlinked", unlinkedReason: "no-link", side: "purchase-correction" });
  });

  it("claims nothing on money out", () => {
    const out: UvaTransaction = {
      id: "t-u-out",
      date: "2026-02-10",
      amount: -3000,
      files: [{ id: "f-own-correction", totalGross: -3000, vatPercent: 20, vatAmount: -500 }],
      correction: unlinked,
    };
    const r = calculateUva({ period: Q1, transactions: [out] });
    expect(r.totalInputVat).toBe(0);
    expect(r.kennzahlen["060"]).toBeUndefined();
    expect(r.unresolved[0]).toMatchObject({ reason: "correction-unlinked" });
    expect(r.corrections[0]).toMatchObject({ side: "sale-correction" });
  });

  it("leaves money in with no File at all as it was (D3)", () => {
    const reversal: UvaTransaction = { id: "t-reversal", date: "2026-02-10", amount: 3000 };
    const r = calculateUva({ period: Q1, transactions: [reversal] });
    expect(kz(r, "022")).toBe(2500);
    expect(r.unresolved[0]).toMatchObject({ reason: "no-file" });
    expect(r.corrections).toEqual([]);
  });
});

describe("correctionAmounts", () => {
  it("rounds per Transaction and caps per rate", () => {
    expect(correctionAmounts(3119, [{ rate: 20, net: 2599, vat: 520 }], 3119)).toEqual({
      groups: [{ rate: 20, net: 2599, vat: 520 }],
      excessVat: 0,
      uncappedVat: 520,
    });
  });
});
