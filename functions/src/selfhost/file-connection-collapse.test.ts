/**
 * The #612 one-time pass over stored File Connection records (#597): a pair
 * written twice keeps its earliest record, a record neither id list mentions
 * goes, and what only one side carries is reported, not changed. Every record
 * it removes names its writer by its shape.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../invoicing/onFileConnectionWrite";
import { collapseFileConnections } from "../fileConnections/collapse";

const db = getFirestore();
const ME = "collapse-me";
const at = (iso: string) => Timestamp.fromDate(new Date(iso));

async function seed() {
  // The …-0003 case of #597: two records 0.5 s apart, plus an orphan to a
  // Transaction of the same amount that neither list names.
  await db.collection("files").doc("f-anthropic").set({ userId: ME, transactionIds: ["t-anthropic"], invoiceId: "inv-1" });
  await db.collection("files").doc("f-openai").set({ userId: ME, transactionIds: ["t-openai"] });
  await db.collection("transactions").doc("t-anthropic").set({ userId: ME, fileIds: ["f-anthropic"] });
  await db.collection("transactions").doc("t-openai").set({ userId: ME, fileIds: ["f-openai"] });
  await db.collection("invoices").doc("inv-1").set({ userId: ME, status: "issued" });
  const burst = { userId: ME, connectionType: "api", matchConfidence: 0 };
  await db.collection("fileConnections").doc("rec-a").set({
    ...burst, fileId: "f-anthropic", transactionId: "t-anthropic", createdAt: at("2026-09-30T15:21:50.349Z"),
  });
  await db.collection("fileConnections").doc("rec-b").set({
    ...burst, fileId: "f-anthropic", transactionId: "t-anthropic", createdAt: at("2026-09-30T15:21:50.851Z"),
  });
  await db.collection("fileConnections").doc("rec-orphan").set({
    ...burst, fileId: "f-anthropic", transactionId: "t-openai", createdAt: at("2026-09-30T15:21:50.852Z"),
  });
  await db.collection("fileConnections").doc("rec-openai").set({
    userId: ME, fileId: "f-openai", transactionId: "t-openai", connectionType: "manual", createdAt: at("2026-09-01T10:00:00Z"),
  });
  // Listed by the File only, and a pair both lists carry with no record.
  await db.collection("files").doc("f-half").set({ userId: ME, transactionIds: ["t-half"] });
  await db.collection("transactions").doc("t-half").set({ userId: ME, fileIds: [] });
  await db.collection("fileConnections").doc("rec-half").set({ userId: ME, fileId: "f-half", transactionId: "t-half" });
  await db.collection("files").doc("f-bare").set({ userId: ME, transactionIds: ["t-bare"] });
  await db.collection("transactions").doc("t-bare").set({ userId: ME, fileIds: ["f-bare"] });
  await drainTriggers();
}

async function recordIds() {
  return (await db.collection("fileConnections").get()).docs.map((d) => d.id).sort();
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("collapsing File Connection records", () => {
  it("reports and writes nothing on a dry run", async () => {
    await seed();
    const report = await collapseFileConnections(db, { apply: false });
    expect(report.removedRecords).toBe(2);
    expect(await recordIds()).toEqual(["rec-a", "rec-b", "rec-half", "rec-openai", "rec-orphan"]);
  });

  it("keeps the earliest record of a pair, removes an orphan, reports the half-listed and unrecorded", async () => {
    await seed();
    const backup: string[] = [];
    const report = await collapseFileConnections(db, {
      apply: true,
      beforeDelete: async (records) => {
        backup.push(...records.map((r) => r.id));
      },
    });

    expect(await recordIds()).toEqual(["rec-a", "rec-half", "rec-openai"]);
    expect(backup.sort()).toEqual(["rec-b", "rec-orphan"]);
    expect(report.duplicates).toEqual([
      expect.objectContaining({ kept: expect.objectContaining({ id: "rec-a" }), removed: [expect.objectContaining({ id: "rec-b" })] }),
    ]);
    expect(report.orphans.map((o) => o.id)).toEqual(["rec-orphan"]);
    expect(report.halfListed).toEqual([expect.objectContaining({ id: "rec-half", listedBy: "file" })]);
    expect(report.unrecorded).toEqual([{ fileId: "f-bare", transactionId: "t-bare", userId: ME }]);
    // The shape names the writer: here the tool surface's, which wrote no
    // origin and no suggestion fields.
    expect(report.removedByFingerprint).toEqual({
      "api|-|connectionType,createdAt,fileId,matchConfidence,transactionId,userId": 2,
    });
  });

  it("leaves an invoice paid when a duplicate of its pair is removed", async () => {
    await seed();
    await db.collection("invoices").doc("inv-1").update({ status: "paid", paidByTransactionId: "t-anthropic" });
    await collapseFileConnections(db, { apply: true });
    await drainTriggers();
    expect((await db.collection("invoices").doc("inv-1").get()).data()!.status).toBe("paid");
  });

  it("holds back an orphan a paid invoice rests on, unless told to revert it", async () => {
    await seed();
    await db.collection("files").doc("f-inv").set({ userId: ME, transactionIds: [], invoiceId: "inv-2" });
    await db.collection("transactions").doc("t-inv").set({ userId: ME, fileIds: [] });
    await db.collection("invoices").doc("inv-2").set({ userId: ME, status: "paid", paidByTransactionId: "t-inv" });
    await db.collection("fileConnections").doc("rec-inv").set({ userId: ME, fileId: "f-inv", transactionId: "t-inv" });

    const dry = await collapseFileConnections(db, { apply: false });
    expect(dry.paidInvoices).toEqual([{ invoiceId: "inv-2", fileId: "f-inv", transactionId: "t-inv", held: true }]);
    expect(dry.removedRecords).toBe(2);

    await collapseFileConnections(db, { apply: true });
    await drainTriggers();
    expect(await recordIds()).toContain("rec-inv");
    expect((await db.collection("invoices").doc("inv-2").get()).data()!.status).toBe("paid");

    const reverted = await collapseFileConnections(db, { apply: true, revertPaidInvoices: true });
    await drainTriggers();
    expect(reverted.paidInvoices).toEqual([{ invoiceId: "inv-2", fileId: "f-inv", transactionId: "t-inv", held: false }]);
    expect(await recordIds()).not.toContain("rec-inv");
    expect((await db.collection("invoices").doc("inv-2").get()).data()!.status).toBe("issued");
  });

  it("skips a removal the app's writes overtook during the run", async () => {
    await seed();
    const report = await collapseFileConnections(db, {
      apply: true,
      // Between the pass's read and its deletes: the orphan's pair is
      // connected, and the duplicate's kept record is Unlinked.
      beforeDelete: async () => {
        await db.collection("files").doc("f-anthropic").update({ transactionIds: ["t-anthropic", "t-openai"] });
        await db.collection("fileConnections").doc("rec-a").delete();
      },
    });

    expect(report.removedRecords).toBe(0);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { fileId: "f-anthropic", transactionId: "t-openai", reason: "the File lists the Transaction now" },
        { fileId: "f-anthropic", transactionId: "t-anthropic", reason: "the kept record is gone" },
      ])
    );
    expect(await recordIds()).toEqual(["rec-b", "rec-half", "rec-openai", "rec-orphan"]);
  });

  it("finds nothing to remove on a second run", async () => {
    await seed();
    await collapseFileConnections(db, { apply: true });
    const again = await collapseFileConnections(db, { apply: true });
    expect(again.removedRecords).toBe(0);
  });
});
