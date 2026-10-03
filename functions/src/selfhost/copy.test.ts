/**
 * A Copy (#162, ADR-0010): a second File of a document FiBuKI already holds.
 * A Copy holds no File Connection and is never proposed as a Match; the system
 * records one only when no File Connection is lost by it, and otherwise only
 * suggests. These cases drive the callables, the Copy check and the tool
 * queue against the self-host database.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import {
  markFileAsCopyCallable,
  unmarkFileAsCopyCallable,
  makeFileTheOriginalCallable,
  backfillCopySuggestionsCallable,
} from "../files/copyCallables";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { runCopyCheck, compareCopyEvidence, copyEvidenceOf, pickOriginal, markFileAsCopy } from "../files/copyOps";
import { runTransactionMatching } from "../matching/matchFileTransactions";
import { listFiles } from "../tools/handlers";

const db = getFirestore();
const ME = "copy-me";
const OTHER = "copy-other";
const DAY = Timestamp.fromDate(new Date("2026-09-10T00:00:00Z"));
const EARLIER = Timestamp.fromDate(new Date("2026-09-11T08:00:00Z"));
const LATER = Timestamp.fromDate(new Date("2026-09-12T08:00:00Z"));

type Callable = { run: (req: unknown) => Promise<unknown> };
function call<T>(fn: unknown, data: unknown, uid = ME): Promise<T> {
  return (fn as Callable).run({ data, auth: { uid, token: {} } }) as Promise<T>;
}

/** An extracted invoice from Hetzner; the overrides make it differ. */
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    userId: ME,
    fileName: "hetzner.pdf",
    extractionComplete: true,
    extractedAmount: 4990,
    extractedCurrency: "EUR",
    extractedDate: DAY,
    extractedInvoiceNumber: "R-0042",
    extractedIssuer: { name: "Hetzner Online GmbH", vatId: "DE812871812" },
    extractedPartner: "Hetzner Online GmbH",
    invoiceDirection: "incoming",
    transactionIds: [],
    createdAt: EARLIER,
    uploadedAt: EARLIER,
    ...overrides,
  };
}

async function file(id: string) {
  return (await db.doc(`files/${id}`).get()).data()!;
}

async function connect(fileId: string, transactionId: string) {
  await db.collection("fileConnections").add({
    userId: ME,
    fileId,
    transactionId,
    connectionType: "manual",
    createdAt: EARLIER,
  });
  const f = await file(fileId);
  await db.doc(`files/${fileId}`).update({ transactionIds: [...(f.transactionIds ?? []), transactionId] });
  const tx = (await db.doc(`transactions/${transactionId}`).get()).data()!;
  await db.doc(`transactions/${transactionId}`).update({ fileIds: [...(tx.fileIds ?? []), fileId], isComplete: true });
}

async function connectionsOf(transactionId: string): Promise<string[]> {
  const snap = await db
    .collection("fileConnections")
    .where("userId", "==", ME)
    .where("transactionId", "==", transactionId)
    .get();
  return snap.docs.map((d) => d.data().fileId as string).sort();
}

async function unmatchedQueue(): Promise<string[]> {
  const r = (await listFiles(ME, { hasConnections: false })) as { files: Array<{ id: string }> };
  return r.files.map((f) => f.id).sort();
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.doc("transactions/tx1").set({
    userId: ME,
    amount: -4990,
    currency: "EUR",
    date: DAY,
    name: "Hetzner Online GmbH",
    partner: "Hetzner Online GmbH",
    fileIds: [],
  });
});

describe("the evidence", () => {
  it("is exact on issuer, invoice number, gross amount and date", () => {
    const a = copyEvidenceOf(invoice());
    expect(compareCopyEvidence(a, copyEvidenceOf(invoice({ fileName: "other.pdf" })))).toBe("exact");
    // The VAT ID decides when both carry one, whatever the names say.
    expect(
      compareCopyEvidence(a, copyEvidenceOf(invoice({ extractedIssuer: { name: "Hetzner", vatId: "DE 812 871 812" } })))
    ).toBe("exact");
    expect(compareCopyEvidence(a, copyEvidenceOf(invoice({ extractedAmount: 4991 })))).toBeNull();
    expect(compareCopyEvidence(a, copyEvidenceOf(invoice({ extractedInvoiceNumber: "R-0043" })))).toBeNull();
    expect(
      compareCopyEvidence(a, copyEvidenceOf(invoice({ extractedDate: Timestamp.fromDate(new Date("2026-09-11T00:00:00Z")) })))
    ).toBeNull();
  });

  it("is only a suggestion when an invoice number is missing", () => {
    expect(
      compareCopyEvidence(copyEvidenceOf(invoice()), copyEvidenceOf(invoice({ extractedInvoiceNumber: null })))
    ).toBe("no-invoice-number");
  });

  it("picks the original: generated invoice, then connected, then earlier", () => {
    const a = { id: "a", data: invoice({ createdAt: EARLIER }) };
    const b = { id: "b", data: invoice({ createdAt: LATER }) };
    expect(pickOriginal(a, b)!.original.id).toBe("a");
    expect(pickOriginal(a, { ...b, data: { ...b.data, transactionIds: ["tx1"] } })!.original.id).toBe("b");
    expect(pickOriginal(a, { ...b, data: { ...b.data, invoiceId: "inv1", transactionIds: [] } })!.original.id).toBe("b");
  });
});

describe("a person marks a Copy", () => {
  it("takes the Copy off the Transaction both were connected to, recording no Rejection", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/dup").set(invoice({ fileName: "hetzner (1).pdf", createdAt: LATER }));
    await connect("orig", "tx1");
    await connect("dup", "tx1");

    await call(markFileAsCopyCallable, { fileId: "dup", originalFileId: "orig" });

    expect(await connectionsOf("tx1")).toEqual(["orig"]);
    const tx = (await db.doc("transactions/tx1").get()).data()!;
    expect(tx.fileIds).toEqual(["orig"]);
    expect(tx.isComplete).toBe(true);
    expect(tx.rejectedFileIds ?? []).toEqual([]);
    const dup = await file("dup");
    expect(dup.copyOfFileId).toBe("orig");
    expect(dup.copyRecordedBy).toBe("user");
    expect(dup.transactionIds).toEqual([]);
  });

  it("moves the File Connection to the original when the original does not hold it", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/dup").set(invoice({ createdAt: LATER }));
    await connect("dup", "tx1");

    await call(markFileAsCopyCallable, { fileId: "dup", originalFileId: "orig" });

    expect(await connectionsOf("tx1")).toEqual(["orig"]);
    expect((await file("orig")).transactionIds).toEqual(["tx1"]);
    expect((await db.doc("transactions/tx1").get()).data()!.fileIds).toEqual(["orig"]);
  });

  it("collapses a chain to the root original", async () => {
    await db.doc("files/a").set(invoice());
    await db.doc("files/b").set(invoice({ createdAt: LATER }));
    await db.doc("files/c").set(invoice({ createdAt: LATER }));
    await call(markFileAsCopyCallable, { fileId: "b", originalFileId: "a" });
    const r = await call<{ originalFileId: string }>(markFileAsCopyCallable, { fileId: "c", originalFileId: "b" });
    expect(r.originalFileId).toBe("a");
    expect((await file("c")).copyOfFileId).toBe("a");
  });

  it("never marks a FiBuKI-generated invoice as the Copy", async () => {
    await db.doc("files/gen").set(invoice({ invoiceId: "inv1", isFibukiGenerated: true }));
    await db.doc("files/mail").set(invoice({ createdAt: LATER }));
    const err = await call(markFileAsCopyCallable, { fileId: "gen", originalFileId: "mail" }).catch((e) => e);
    expect(err.code).toBe("failed-precondition");
    expect((await file("gen")).copyOfFileId).toBeUndefined();
  });

  it("refuses another user's File on either side, like a missing one", async () => {
    await db.doc("files/mine").set(invoice());
    await db.doc("files/theirs").set(invoice({ userId: OTHER }));
    const a = await call(markFileAsCopyCallable, { fileId: "mine", originalFileId: "theirs" }).catch((e) => e);
    const b = await call(markFileAsCopyCallable, { fileId: "theirs", originalFileId: "mine" }).catch((e) => e);
    expect(a.code).toBe("not-found");
    expect(b.code).toBe("not-found");
    expect((await file("theirs")).copyOfFileId).toBeUndefined();
    expect((await file("mine")).copyOfFileId).toBeUndefined();
  });
});

describe("a Copy and the queue", () => {
  it("stays out of the unmatched queue while its original is live, deleted or restored", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/dup").set(invoice({ createdAt: LATER }));
    await call(markFileAsCopyCallable, { fileId: "dup", originalFileId: "orig" });
    expect(await unmatchedQueue()).toEqual(["orig"]);

    await db.doc("files/orig").update({ deletedAt: LATER });
    expect(await unmatchedQueue()).toEqual(["dup"]);

    await db.doc("files/orig").update({ deletedAt: null });
    expect(await unmatchedQueue()).toEqual(["orig"]);
  });

  it("is never proposed as a Match or connected, even against a perfect Transaction", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/dup").set(invoice({ createdAt: LATER }));
    await call(markFileAsCopyCallable, { fileId: "dup", originalFileId: "orig" });

    await runTransactionMatching("dup", await file("dup"));
    const dup = await file("dup");
    expect(dup.transactionSuggestions).toEqual([]);
    expect(dup.transactionIds).toEqual([]);

    const err = await call(connectFileToTransactionCallable, { fileId: "dup", transactionId: "tx1" }).catch((e) => e);
    expect(err.code).toBe("failed-precondition");
    expect(err.message).toMatch(/COPY_HOLDS_NO_CONNECTION/);
  });
});

describe("the Copy check", () => {
  it("records an unconnected exact match on its own, so it never reaches the queue", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/new").set(invoice({ createdAt: LATER, fileName: "Rechnung R-0042.pdf" }));

    const outcome = await runCopyCheck(db, "new", await file("new"));
    expect(outcome).toEqual({ kind: "recorded-this", originalFileId: "orig" });
    expect((await file("new")).copyRecordedBy).toBe("system");
    expect(await unmatchedQueue()).toEqual(["orig"]);
  });

  it("only suggests when marking would take a File Connection apart", async () => {
    // Both are connected, so the newer one is the Copy, and marking it would
    // take its File Connection apart: that needs a person.
    await db.doc("files/old").set(invoice());
    await db.doc("files/new").set(invoice({ createdAt: LATER }));
    await connect("old", "tx1");
    await connect("new", "tx1");

    const outcome = await runCopyCheck(db, "new", await file("new"));
    expect(outcome.kind).toBe("suggested");
    expect(await connectionsOf("tx1")).toEqual(["new", "old"]);
    expect((await file("new")).copySuggestion?.originalFileId).toBe("old");
    expect((await file("new")).copyOfFileId).toBeUndefined();
  });

  it("refuses to record a File connected since the check looked, leaving its File Connection", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/new").set(invoice({ createdAt: LATER }));
    await connect("new", "tx1");
    const err = await markFileAsCopy(db, ME, { fileId: "new", originalFileId: "orig" }, "system").catch((e) => e);
    expect(err.code).toBe("failed-precondition");
    expect(await connectionsOf("tx1")).toEqual(["new"]);
    expect((await file("new")).copyOfFileId).toBeUndefined();
  });

  it("only suggests when an invoice number is missing", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/new").set(invoice({ createdAt: LATER, extractedInvoiceNumber: null }));
    const outcome = await runCopyCheck(db, "new", await file("new"));
    expect(outcome).toMatchObject({ kind: "suggested", reason: "no-invoice-number" });
  });

  it("does not offer a declined suggestion again after re-extraction", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/new").set(invoice({ createdAt: LATER, extractedInvoiceNumber: null }));
    await runCopyCheck(db, "new", await file("new"));

    const r = await call<{ outcome: string }>(unmarkFileAsCopyCallable, { fileId: "new" });
    expect(r.outcome).toBe("declined");

    // Re-extraction rewrites the extracted fields; the ruling is not one of them.
    await db.doc("files/new").update({ extractedInvoiceNumber: "R-0042" });
    expect(await runCopyCheck(db, "new", await file("new"))).toEqual({ kind: "none" });
    expect((await file("new")).copySuggestion ?? null).toBeNull();
  });

  it("does not record a Copy the user undid", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/new").set(invoice({ createdAt: LATER }));
    await runCopyCheck(db, "new", await file("new"));
    await call(unmarkFileAsCopyCallable, { fileId: "new" });
    expect(await runCopyCheck(db, "new", await file("new"))).toEqual({ kind: "none" });
    expect((await file("new")).copyOfFileId).toBeNull();
  });
});

describe("make this the original", () => {
  it("swaps the two Files and moves the File Connection in one act", async () => {
    await db.doc("files/orig").set(invoice());
    await db.doc("files/dup").set(invoice({ createdAt: LATER }));
    await connect("orig", "tx1");
    await call(markFileAsCopyCallable, { fileId: "dup", originalFileId: "orig" });

    await call(makeFileTheOriginalCallable, { fileId: "dup" });

    expect((await file("dup")).copyOfFileId).toBeNull();
    expect((await file("orig")).copyOfFileId).toBe("dup");
    expect(await connectionsOf("tx1")).toEqual(["dup"]);
    expect((await db.doc("transactions/tx1").get()).data()!.fileIds).toEqual(["dup"]);
  });
});

describe("the one-time pass", () => {
  it("suggests, never records: same bytes, and a re-send hidden as not an invoice", async () => {
    await db.doc("files/a").set(invoice({ contentHash: "h1" }));
    await db.doc("files/a2").set(invoice({ contentHash: "h1", createdAt: LATER }));
    await db.doc("files/b").set(invoice({ fileName: "Rechnung-77.pdf", extractedInvoiceNumber: "R-0077", extractedAmount: 1200 }));
    await db.doc("files/b-resend").set({
      userId: ME,
      fileName: "Rechnung-77 (1).pdf",
      isNotInvoice: true,
      notInvoiceReason: "duplicate re-send",
      extractionComplete: true,
      transactionIds: [],
      createdAt: LATER,
    });

    // The same photo received twice, both marked not an invoice: not a Copy.
    await db.doc("files/photo").set({ userId: ME, fileName: "screen.jpeg", contentHash: "h2", isNotInvoice: true, transactionIds: [], createdAt: EARLIER });
    await db.doc("files/photo2").set({ userId: ME, fileName: "screen.jpeg", contentHash: "h2", isNotInvoice: true, transactionIds: [], createdAt: LATER });
    // An invoice and its byte-identical re-send hidden as not an invoice, under another name.
    await db.doc("files/c").set(invoice({ fileName: "R-0099.pdf", extractedInvoiceNumber: "R-0099", extractedAmount: 3300, contentHash: "h3" }));
    await db.doc("files/c-hidden").set({ userId: ME, fileName: "attachment.pdf", contentHash: "h3", isNotInvoice: true, transactionIds: [], createdAt: EARLIER });

    const r = await call<{ sameContent: number; markedNotInvoice: number }>(backfillCopySuggestionsCallable, {});
    expect(r).toMatchObject({ sameContent: 2, markedNotInvoice: 1 });
    expect((await file("a2")).copySuggestion).toMatchObject({ originalFileId: "a", reason: "same-content" });
    expect((await file("b-resend")).copySuggestion).toMatchObject({ originalFileId: "b", reason: "marked-not-invoice" });
    expect((await file("a2")).copyOfFileId).toBeUndefined();
    expect((await file("photo")).copySuggestion).toBeUndefined();
    expect((await file("photo2")).copySuggestion).toBeUndefined();
    expect((await file("c-hidden")).copySuggestion).toMatchObject({ originalFileId: "c", reason: "same-content" });

    // Accepting the re-send's suggestion sets the Copy and lifts the mark.
    await call(markFileAsCopyCallable, { fileId: "b-resend", originalFileId: "b" });
    const resend = await file("b-resend");
    expect(resend.copyOfFileId).toBe("b");
    expect(resend.isNotInvoice).toBe(false);
  });
});
