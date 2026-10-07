/**
 * The activity log (#752): every change a person, the matcher or an AI makes
 * to a File or a Transaction leaves one line on the item, with who made it.
 * A run that changes nothing writes nothing.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { applyFactChange } from "../fileFacts/applyFactChange";
import { createFileRecord } from "../files/createFileRecord";
import { performDeleteFile } from "../files/deleteFile";
import { connectFiles, unlinkFile } from "../fileConnections/writer";
import { transactionSuggestionsActivity } from "../matching/suggestionActivity";
import { assignNoReceiptCategoryToTransaction } from "../matching/assignNoReceiptCategory";
import { bulkUpdateTransactionsCallable } from "../transactions/bulkUpdateTransactions";
import { assignPartnerToFile, removePartnerFromFile } from "../files/filePartner";
import { mergeUserPartnersInternal } from "../partners/mergeUserPartners";

const db = getFirestore();
const ME = "activity-me";
const DAY = Timestamp.fromDate(new Date("2026-09-10T00:00:00Z"));

type Entry = { type: string; actor: string; summary: string; level: string; transactionId?: string; fileId?: string };

async function log(collection: "files" | "transactions", id: string): Promise<Entry[]> {
  const data = (await db.collection(collection).doc(id).get()).data() ?? {};
  return (data.automationHistory ?? []) as Entry[];
}

async function seedFile(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    extractionComplete: true,
    extractedAmount: 4990,
    extractedCurrency: "EUR",
    extractedDate: DAY,
    transactionIds: [],
    ...extra,
  });
}

async function seedTx(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: ME,
    amount: -4990,
    currency: "EUR",
    date: DAY,
    name: "HETZNER ONLINE",
    fileIds: [],
    ...extra,
  });
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("a File's facts", () => {
  it("a person's correction is logged as theirs, naming the facts", async () => {
    await seedFile("f1");
    await applyFactChange(db, { fileId: "f1", userId: ME, change: { origin: "ui-correction", correction: { amount: 1000 } } });
    const [entry] = await log("files", "f1");
    expect(entry).toMatchObject({ type: "facts_corrected", actor: "manual", level: "decision" });
    expect(entry.summary).toContain("amount");
  });

  it("the assistant's correction is logged as AI", async () => {
    await seedFile("f1");
    await applyFactChange(db, { fileId: "f1", userId: ME, change: { origin: "mcp-correction", correction: { amount: 1000 } } });
    expect((await log("files", "f1"))[0]).toMatchObject({ type: "facts_corrected", actor: "ai", level: "outcome" });
  });

  it("a change that moves nothing writes no line", async () => {
    await seedFile("f1");
    await applyFactChange(db, { fileId: "f1", userId: ME, change: { origin: "ui-correction", correction: { amount: 4990 } } });
    expect(await log("files", "f1")).toEqual([]);
  });

  it("the not-invoice ruling says who made it", async () => {
    await seedFile("f1");
    await applyFactChange(db, { fileId: "f1", userId: ME, change: { origin: "not-invoice", reason: "a quote" }, actor: "ai" });
    expect((await log("files", "f1"))[0]).toMatchObject({ type: "marked_not_invoice", actor: "ai" });
  });
});

describe("a File's first line", () => {
  it("names where an automatic import came from", async () => {
    const { fileId } = await createFileRecord(db, { userId: ME, fileName: "inv.pdf", contentHash: "h1", sourceType: "gmail" });
    expect((await log("files", fileId))[0]).toMatchObject({ type: "file_created", actor: "auto", summary: "Imported from a mailbox" });
  });

  it("an upload is the User's", async () => {
    const { fileId } = await createFileRecord(db, { userId: ME, fileName: "inv.pdf", contentHash: "h2", sourceType: "upload" });
    expect((await log("files", fileId))[0]).toMatchObject({ type: "file_created", actor: "manual" });
  });
});

describe("Transaction suggestions on a File", () => {
  const s = (transactionId: string, confidence = 80) => ({ transactionId, confidence, preview: { name: `tx ${transactionId}` } });

  it("are logged when the best one changes, and only then", () => {
    expect(transactionSuggestionsActivity([], [s("t1")], "matching")).toMatchObject({ type: "transaction_suggested", actor: "auto", level: "info" });
    expect(transactionSuggestionsActivity([s("t1", 70)], [s("t1", 85)], "matching")).toBeNull();
    expect(transactionSuggestionsActivity([s("t1")], [s("t2")], "matching")?.summary).toContain("tx t2");
    expect(transactionSuggestionsActivity([s("t1")], [], "matching")?.summary).toContain("No Transaction suggested");
    expect(transactionSuggestionsActivity(undefined, [], "matching")).toBeNull();
  });
});

describe("File Connections, on both sides", () => {
  beforeEach(async () => {
    await seedFile("f1");
    await seedTx("t1");
  });

  it("an automatic connect is logged on the File as well as the Transaction", async () => {
    await connectFiles(db, ME, [{ fileId: "f1", transactionId: "t1", matchConfidence: 91 }], { origin: "auto" });
    expect(await log("transactions", "t1")).toEqual([expect.objectContaining({ type: "file_connected", actor: "auto" })]);
    expect(await log("files", "f1")).toEqual([
      expect.objectContaining({ type: "transaction_connected", actor: "auto", transactionId: "t1" }),
    ]);
  });

  it("confirming an automatic connect is logged on both", async () => {
    await connectFiles(db, ME, [{ fileId: "f1", transactionId: "t1" }], { origin: "auto" });
    await connectFiles(db, ME, [{ fileId: "f1", transactionId: "t1" }], { origin: "manual" });
    expect((await log("files", "f1")).map((e) => e.type)).toContain("connection_confirmed");
    expect((await log("transactions", "t1")).map((e) => e.type)).toContain("connection_confirmed");
  });

  it("an unlink is logged on the File, with who did it", async () => {
    await connectFiles(db, ME, [{ fileId: "f1", transactionId: "t1" }], { origin: "manual" });
    await unlinkFile(db, ME, { fileId: "f1", transactionId: "t1", actor: "ai" });
    expect((await log("files", "f1")).at(-1)).toMatchObject({ type: "transaction_disconnected", actor: "ai" });
    expect((await log("transactions", "t1")).find((e) => e.type === "file_disconnected")).toMatchObject({ actor: "ai", level: "outcome" });
  });

  it("a File deleted by folder sync says so on the File and on its Transaction", async () => {
    await connectFiles(db, ME, [{ fileId: "f1", transactionId: "t1" }], { origin: "manual" });
    const data = (await db.collection("files").doc("f1").get()).data()!;
    await performDeleteFile(db, ME, "f1", data, { actor: "auto", summary: "Deleted because it was removed from the synced folder" });
    expect((await log("files", "f1")).find((e) => e.type === "file_deleted")).toMatchObject({ actor: "auto" });
    const disconnected = (await log("transactions", "t1")).find((e) => e.type === "file_disconnected");
    expect(disconnected).toMatchObject({ actor: "auto" });
    expect(disconnected?.summary).toContain("removed from the synced folder");
  });
});

describe("Transactions: categories, the agent, bulk edits (#752 part 2)", () => {
  beforeEach(async () => {
    await seedTx("t1");
    await db.collection("noReceiptCategories").doc("c1").set({ userId: ME, name: "Bank fees", templateId: "bank-fees", isActive: true, matchedPartnerIds: [], transactionCount: 0 });
  });

  it("a category assigned through the shared writer names who did it", async () => {
    await assignNoReceiptCategoryToTransaction(db, ME, { transactionId: "t1", categoryId: "c1", matchedBy: "manual", actor: "ai" });
    expect((await log("transactions", "t1"))[0]).toMatchObject({ type: "category_assigned", actor: "ai", summary: 'Category "Bank fees" assigned' });
  });

  it("the agent's connect is logged as AI, not as the User", async () => {
    await seedFile("f1");
    await connectFiles(db, ME, [{ fileId: "f1", transactionId: "t1" }], { origin: "agent" });
    expect((await log("transactions", "t1"))[0]).toMatchObject({ type: "file_connected", actor: "ai" });
  });

  it("a bulk edit from the agent logs each row as AI", async () => {
    await (bulkUpdateTransactionsCallable as unknown as { run: (r: unknown) => Promise<unknown> }).run({
      data: { ids: ["t1"], data: { noReceiptCategoryId: "c1", noReceiptCategoryMatchedBy: "manual" }, actor: "ai" },
      auth: { uid: ME, token: {} },
    });
    expect((await log("transactions", "t1"))[0]).toMatchObject({ type: "category_assigned", actor: "ai" });
  });
});

describe("Partners on Files, and merges (#752 part 2)", () => {
  beforeEach(async () => {
    await db.collection("partners").doc("p1").set({ userId: ME, name: "Hetzner Online GmbH", aliases: [], ibans: [] });
    await db.collection("partners").doc("p2").set({ userId: ME, name: "Hetzner Online", aliases: [], ibans: [] });
    await seedFile("f1");
  });

  it("assigning, confirming and removing a File's Partner are logged", async () => {
    await assignPartnerToFile(db, ME, { fileId: "f1", partnerId: "p1", partnerType: "user", matchedBy: "auto", confidence: 92 });
    await assignPartnerToFile(db, ME, { fileId: "f1", partnerId: "p1", partnerType: "user", matchedBy: "manual" });
    await removePartnerFromFile(db, ME, "f1", "ai");
    const entries = await log("files", "f1");
    expect(entries.map((e) => [e.type, e.actor])).toEqual([
      ["partner_assigned", "auto"],
      ["partner_assigned", "manual"],
      ["partner_removed", "ai"],
    ]);
    expect(entries[1].summary).toContain("confirmed");
  });

  it("a merge logs the new Partner on every item that moved", async () => {
    await seedTx("t1", { partnerId: "p2", partnerType: "user", partnerMatchedBy: "manual" });
    await db.collection("files").doc("f1").update({ partnerId: "p2", partnerType: "user" });
    await mergeUserPartnersInternal(db, ME, { survivorId: "p1", loserIds: ["p2"] });
    for (const [collection, id] of [["transactions", "t1"], ["files", "f1"]] as const) {
      expect((await log(collection, id)).at(-1)).toMatchObject({ type: "partner_assigned", actor: "manual", forPartnerId: "p1" });
    }
  });
});
