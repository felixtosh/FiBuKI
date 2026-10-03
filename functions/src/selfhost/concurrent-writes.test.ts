/**
 * Plain document writes on self-host are atomic against the stored document,
 * like Firestore's (#503). update() and set(merge) used to read the document
 * in one database transaction, merge in Node, and write the whole document
 * back in another, so a writer that read before a concurrent one wrote put the
 * old copy back. On fibuki.com that left File Connections one-sided (the File
 * kept the Transaction, the Transaction lost the File) and reverted a manual
 * category seconds after it was set.
 *
 * Transactions and batches have their own suite (transactions-isolation.test.ts).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, FieldValue, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim, onDocumentUpdated, type FirestoreEvent } from "./trigger-shim";

// REAL application code, unmodified:
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { assignPartnerToTransactionCallable } from "../partners/assignPartnerToTransaction";

const db = getFirestore();
const USER = "stefan-test";

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("plain writes racing on one document", () => {
  it("two updates to different fields both survive, arrayUnion included", async () => {
    await db.doc("transactions/t1").set({ userId: USER, fileIds: [] });
    await Promise.all([
      db.doc("transactions/t1").update({ fileIds: FieldValue.arrayUnion("file1") }),
      db.doc("transactions/t1").update({ partnerId: "p1" }),
    ]);
    expect((await db.doc("transactions/t1").get()).data()).toEqual({
      userId: USER,
      fileIds: ["file1"],
      partnerId: "p1",
    });
  });

  it("arrayUnions into the same array all survive", async () => {
    await db.doc("transactions/t1").set({ userId: USER, fileIds: [] });
    await Promise.all(
      ["f1", "f2", "f3", "f4"].map((id) => db.doc("transactions/t1").update({ fileIds: FieldValue.arrayUnion(id) })),
    );
    const fileIds = (await db.doc("transactions/t1").get()).data()!.fileIds as string[];
    expect([...fileIds].sort()).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("set(merge) racing update() keeps both changes", async () => {
    await db.doc("transactions/t1").set({ userId: USER, fileIds: [] });
    await Promise.all([
      db.doc("transactions/t1").set({ noReceiptCategoryId: "cat-manual" }, { merge: true }),
      db.doc("transactions/t1").update({ fileIds: FieldValue.arrayUnion("file1") }),
    ]);
    expect((await db.doc("transactions/t1").get()).data()).toEqual({
      userId: USER,
      fileIds: ["file1"],
      noReceiptCategoryId: "cat-manual",
    });
  });

  it("increments from many writers add up", async () => {
    await db.doc("config/counter").set({ n: 0 });
    await Promise.all(Array.from({ length: 8 }, () => db.doc("config/counter").update({ n: FieldValue.increment(1) })));
    expect((await db.doc("config/counter").get()).data()).toEqual({ n: 8 });
  });

  it("an update racing a delete never resurrects the document", async () => {
    await db.doc("transactions/t1").set({ userId: USER });
    const results = await Promise.allSettled([
      db.doc("transactions/t1").delete(),
      db.doc("transactions/t1").update({ partnerId: "p1" }),
    ]);
    const stored = (await db.doc("transactions/t1").get()).data();
    // Either the update landed first and the delete removed both, or the
    // delete landed first and the update failed on a missing document.
    expect(stored).toBeUndefined();
    if (results[1].status === "rejected") expect(String(results[1].reason)).toMatch(/missing doc/);
  });
});

describe("triggers see what was really stored", () => {
  const events: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> = [];
  onDocumentUpdated("raceTriggerDocs/{id}", (e: FirestoreEvent) => {
    const change = e.data as { before: { data(): Record<string, unknown> }; after: { data(): Record<string, unknown> } };
    events.push({ before: change.before.data(), after: change.after.data() });
  });

  it("each update's before image is the document the other writer left", async () => {
    events.length = 0;
    await db.doc("raceTriggerDocs/d1").set({ a: 0, b: 0 });
    await drainTriggers();
    await Promise.all([db.doc("raceTriggerDocs/d1").update({ a: 1 }), db.doc("raceTriggerDocs/d1").update({ b: 1 })]);
    await drainTriggers();

    expect(events).toHaveLength(2);
    // The two changes form one chain: the first starts from the stored
    // document, the second from exactly what the first wrote.
    const [first, second] = events[0].before.a === 0 && events[0].before.b === 0 ? events : [events[1], events[0]];
    expect(first.before).toEqual({ a: 0, b: 0 });
    expect(second.before).toEqual(first.after);
    expect(second.after).toEqual({ a: 1, b: 1 });
  });
});

describe("the reported case: connect a File while the partner is assigned", () => {
  it("the File Connection is on both sides and the partner is set", async () => {
    await db.doc("partners/p1").set({
      userId: USER,
      name: "Amazon",
      aliases: [],
      ibans: [],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await db.doc("transactions/t1").set({
      userId: USER,
      sourceId: "src-1",
      date: Timestamp.fromDate(new Date("2026-09-12T00:00:00Z")),
      amount: 2399,
      currency: "EUR",
      name: "Amazon refund",
      fileIds: [],
      isComplete: false,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await db.doc("files/f1").set({
      userId: USER,
      fileName: "credit-note.pdf",
      transactionIds: [],
      transactionSuggestions: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    await Promise.all([
      connectFileToTransactionCallable.run({ data: { fileId: "f1", transactionId: "t1" }, auth: { uid: USER } } as never),
      assignPartnerToTransactionCallable.run({
        data: { transactionId: "t1", partnerId: "p1", partnerType: "user", matchedBy: "auto" },
        auth: { uid: USER },
      } as never),
    ]);
    await drainTriggers();
    await __whenShimIdle();

    const tx = (await db.doc("transactions/t1").get()).data()!;
    const file = (await db.doc("files/f1").get()).data()!;
    expect(file.transactionIds).toEqual(["t1"]);
    expect(tx.fileIds).toEqual(["f1"]);
    expect(tx.partnerId).toBe("p1");
  });
});
