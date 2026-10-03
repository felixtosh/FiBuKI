/**
 * Mark as filed, end to end (#564, D11-D17): the record is kept, refused while
 * the period has blockers, compared against later runs, raised on the next
 * period's handover, and never visible to another user.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { markUvaPeriodFiledCallable, getUvaFiledStatusCallable } from "../reports/uvaFiledRecords";
import { prepareUvaFilingCallable } from "../reports/prepareUvaFiling";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";
const Q1 = { year: 2026, period: 1, type: "quarterly" as const };
const Q2 = { year: 2026, period: 2, type: "quarterly" as const };
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));

const as = (uid: string) => ({ uid, token: {} });
const mark = (data: unknown, uid = USER) => markUvaPeriodFiledCallable.run({ data, auth: as(uid) } as never) as Promise<any>;
const status = (data: unknown, uid = USER) => getUvaFiledStatusCallable.run({ data, auth: as(uid) } as never) as Promise<any>;

async function seedTx(id: string, date: string, amount: number, fileIds: string[]) {
  await db.collection("transactions").doc(id).set({
    userId: USER, sourceId: "src", date: day(date), amount, currency: "EUR", partner: id, fileIds, isComplete: true,
  });
}
async function seedFile(id: string, data: Record<string, unknown>) {
  await db.collection("files").doc(id).set({ userId: USER, ...data });
}

/** A 120,00 purchase at 20% in January, and a 30,00 refund in February with its credit note. */
async function seedQuarter(linked: boolean) {
  await seedFile("f-invoice", { extractedAmount: 12000, extractedVatAmount: 2000, extractedVatPercent: 20, transactionIds: ["t-purchase"] });
  await seedTx("t-purchase", "2026-01-05", -12000, ["f-invoice"]);
  await seedFile("f-credit", {
    extractedAmount: -3000, extractedVatAmount: -500, extractedVatPercent: 20, extractedSelfDesignation: "Gutschrift",
    transactionIds: ["t-refund"],
    ...(linked ? { correctionLink: { fileId: "f-invoice", setBy: "manual" } } : {}),
  });
  await seedTx("t-refund", "2026-02-10", 3000, ["f-credit"]);
}

beforeEach(async () => {
  await __whenShimIdle();
  __resetFirestoreShim();
  __resetTriggerShim();
});

describe("Mark as filed", () => {
  it("is refused while the period has an unlinked correction", async () => {
    await seedQuarter(false);
    await expect(mark({ period: Q1 })).rejects.toThrow(/correction-unlinked/);
    expect((await status({ period: Q1 })).blockers.map((b: { code: string }) => b.code)).toEqual(["correction-unlinked"]);
  });

  it("records the calculated figures, or the ones filed by hand", async () => {
    await seedQuarter(true);
    const r = await mark({ period: Q1 });
    expect(r.record).toMatchObject({ periodKey: "2026-Q1", source: "mark-as-filed", editedByHand: false });
    expect(r.record.kennzahlen).toMatchObject({ "060": 2000, "067": -500, "095": -1500 });

    const byHand = await mark({ period: Q1, kennzahlen: { "060": 2000, "067": -500, "095": -1400 }, note: "hapala" });
    expect(byHand.record).toMatchObject({ editedByHand: true, note: "hapala" });
    expect((await status({ period: Q1 })).filed.history).toHaveLength(2);
  });

  it("refuses figures that cannot be compared", async () => {
    await seedQuarter(true);
    await expect(mark({ period: Q1, kennzahlen: { "060": 2000 } })).rejects.toThrow(/KZ 095/);
  });

  it("shows filed vs now once a later run moves the figures, with the Transaction that moved them", async () => {
    await seedQuarter(true);
    await mark({ period: Q1 });
    await seedFile("f-late", { extractedAmount: 6000, extractedVatAmount: 1000, extractedVatPercent: 20, transactionIds: ["t-late"] });
    await seedTx("t-late", "2026-03-01", -6000, ["f-late"]);
    const s = await status({ period: Q1 });
    expect(s.filed.comparison).toMatchObject({ moved: true, balanceMoved: true, balanceDelta: -1000 });
    expect(s.filed.comparison.transactions.map((m: { transactionId: string }) => m.transactionId)).toEqual(["t-late"]);
  });

  it("raises a moved filed period on the next period's handover", async () => {
    await seedQuarter(true);
    await mark({ period: Q1 });
    await seedTx("t-late-sale", "2026-03-01", 2400, []);
    expect((await status({ period: Q2 })).earlierFiledMoved.map((c: { periodKey: string }) => c.periodKey)).toEqual(["2026-Q1"]);
    const prepared = (await prepareUvaFilingCallable.run({ data: { period: Q2 }, auth: as(USER) } as never)) as any;
    expect(prepared.filing.filedPeriodsMoved.map((c: { periodKey: string }) => c.periodKey)).toEqual(["2026-Q1"]);
  });

  it("never shows one user's filed records to another", async () => {
    await seedQuarter(true);
    await mark({ period: Q1 });
    const theirs = await status({ period: Q1 }, OTHER);
    expect(theirs.filed).toBeNull();
    expect(theirs.earlierFiledMoved).toEqual([]);
  });
});
