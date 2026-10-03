/**
 * Refunds through the real period run (#564): the records as stored, the
 * correction resolved from them, the Kennzahlen that come out.
 *
 * The pure calculation is pinned in `uva/correction.test.ts`; this proves the
 * fetch half finds the original, its payer and the earlier refunds through
 * the data layer, and never across users.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { runUvaForPeriod } from "../reports/uvaPeriodRun";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";
const Q1 = { year: 2026, period: 1, type: "quarterly" as const };
const Q2 = { year: 2026, period: 2, type: "quarterly" as const };

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));

async function seedTx(id: string, date: string, amount: number, fileIds: string[], userId = USER) {
  await db.collection("transactions").doc(id).set({
    userId,
    sourceId: "src",
    date: day(date),
    amount,
    currency: "EUR",
    partner: "Amazon",
    fileIds,
    isComplete: true,
  });
}

async function seedFile(id: string, data: Record<string, unknown>, userId = USER) {
  await db.collection("files").doc(id).set({ userId, ...data });
}

/** A 120,00 purchase at 20%, paid on 5 January. */
async function seedPurchase(userId = USER) {
  await seedFile(
    "f-invoice",
    {
      extractedAmount: 12000,
      extractedVatAmount: 2000,
      extractedVatPercent: 20,
      extractedInvoiceNumber: "INV-1",
      invoiceDirection: "incoming",
      transactionIds: ["t-purchase"],
    },
    userId
  );
  await seedTx("t-purchase", "2026-01-05", -12000, ["f-invoice"], userId);
}

async function seedRefund(id: string, date: string, amount: number, link: string | null) {
  await seedFile(`${id}-credit`, {
    extractedAmount: -amount,
    extractedVatAmount: -Math.round((amount * 20) / 120),
    extractedVatPercent: 20,
    extractedSelfDesignation: "Gutschrift",
    transactionIds: [id],
    ...(link ? { correctionLink: { fileId: link, setBy: "auto" } } : {}),
  });
  await seedTx(id, date, amount, [`${id}-credit`]);
}

beforeEach(async () => {
  await __whenShimIdle();
  __resetFirestoreShim();
  __resetTriggerShim();
});

describe("the period run resolves refunds (#564)", () => {
  it("books a linked refund in KZ 067 and leaves the revenue alone", async () => {
    await seedPurchase();
    await seedRefund("t-refund", "2026-02-10", 3000, "f-invoice");
    const { result } = await runUvaForPeriod(db as never, USER, Q1);
    expect(result.kennzahlen["067"].value).toBe(-500);
    expect(result.kennzahlen["060"].value).toBe(2000);
    expect(result.kennzahlen["022"]).toBeUndefined();
    expect(result.corrections[0]).toMatchObject({
      status: "linked",
      originalFileId: "f-invoice",
      paidByTransactionIds: ["t-purchase"],
    });
  });

  it("caps a second refund in a later quarter by the first", async () => {
    await seedPurchase();
    await seedRefund("t-r1", "2026-03-20", 9000, "f-invoice");
    await seedRefund("t-r2", "2026-05-04", 6000, "f-invoice");
    const q2 = (await runUvaForPeriod(db as never, USER, Q2)).result;
    // 90,00 of 120,00 took back 15,00 of the 20,00; 60,00 more would take 10,00.
    expect(q2.kennzahlen["067"].value).toBe(-500);
    expect(q2.corrections[0]).toMatchObject({ excessVat: 500 });
  });

  it("keeps an unlinked credit note at the safe default and reports it", async () => {
    await seedRefund("t-refund", "2026-02-10", 3000, null);
    const { result } = await runUvaForPeriod(db as never, USER, Q1);
    expect(result.kennzahlen["022"].value).toBe(2500);
    expect(result.corrections[0]).toMatchObject({ status: "unlinked", unlinkedReason: "no-link" });
  });

  it("never resolves a link to another user's File", async () => {
    await seedPurchase(OTHER);
    await seedRefund("t-refund", "2026-02-10", 3000, "f-invoice");
    const { result } = await runUvaForPeriod(db as never, USER, Q1);
    expect(result.kennzahlen["067"]).toBeUndefined();
    expect(result.corrections[0]).toMatchObject({ status: "unlinked", unlinkedReason: "original-unpaid" });
  });
});
