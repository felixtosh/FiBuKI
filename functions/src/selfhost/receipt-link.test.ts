/**
 * A Receipt and the invoice it pays, through the data layer (#571, ADR-0012).
 *
 * The real matching chain (Partner matching, then transaction matching, the
 * Copy check and the pair check) runs on the self-host shim, unmodified. The
 * GitHub/Stripe shape is the one that opened the ticket: the Receipt prints
 * every § 11 element and carries the invoice's number as its own, beside the
 * number it cites as paid.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../matching/matchFilePartner";
import "../matching/matchFileTransactions";
import { loadDocumentedAmounts } from "../matching/documentedAmounts";
import { connectFile, unlinkFile } from "../fileConnections/writer";
import {
  getReceiptLink,
  linkReceipt,
  runReceiptPairCheck,
  unlinkReceipt,
} from "../receiptPairs/receiptPairOps";
import {
  backfillReceiptPairsCallable,
  getReceiptLinkCallable,
  linkReceiptCallable,
  unlinkReceiptCallable,
} from "../receiptPairs/receiptPairCallables";
import { markFileAsCopy } from "../files/copyOps";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";
const IBAN = "AT61 1904 3002 3457 3201";
const GITHUB = { name: "GitHub, Inc.", vatId: "EU372000041" };
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));
const auth = { uid: USER, token: {} };

async function file(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

async function connectionOf(fileId: string, transactionId: string) {
  return (await db.collection("fileConnections").doc(`${fileId}__${transactionId}`).get()).data();
}

/** A File as Extraction leaves it, arriving through the real trigger chain. */
async function arrive(id: string, fields: Record<string, unknown>) {
  await db.collection("files").doc(id).set({
    userId: USER,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: false,
    transactionIds: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  await db.collection("files").doc(id).update({
    extractionComplete: true,
    extractedPartner: "GitHub, Inc.",
    extractedIban: IBAN,
    extractedAmount: 2000,
    extractedCurrency: "EUR",
    extractedDate: day("2026-07-01"),
    extractedIssuer: GITHUB,
    documentType: "invoice",
    updatedAt: Timestamp.now(),
    ...fields,
  });
  await drainTriggers();
}

const invoiceFields = { extractedInvoiceNumber: "INV-1" };
/** GitHub's Receipt: the invoice's number in its own field, and cited as paid. */
const receiptFields = {
  extractedSelfDesignation: "Receipt",
  extractedInvoiceNumber: "INV-1",
  extractedPaidInvoiceNumber: "INV-1",
};

/** A File seeded directly, for the checks run without the trigger chain. */
async function seedFile(id: string, data: Record<string, unknown>, userId = USER) {
  await db.collection("files").doc(id).set({
    userId,
    fileName: `${id}.pdf`,
    partnerId: "p-github",
    extractionComplete: true,
    partnerMatchComplete: true,
    extractedAmount: 2000,
    extractedCurrency: "EUR",
    extractedDate: day("2026-07-01"),
    extractedIssuer: GITHUB,
    transactionIds: [],
    ...data,
  });
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("subscriptions").doc(USER).set({ userId: USER, automationMode: "active", planId: "free" });
  await db.collection("partners").doc("p-github").set({
    userId: USER,
    name: "GitHub, Inc.",
    aliases: ["GitHub"],
    ibans: [IBAN],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
  await db.collection("transactions").doc("t-gh").set({
    userId: USER,
    sourceId: "src",
    date: day("2026-07-01"),
    amount: -2000,
    currency: "EUR",
    name: "GitHub, Inc.",
    partner: "GitHub, Inc.",
    partnerIban: IBAN,
    fileIds: [],
    isComplete: false,
    partnerId: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
});

describe("the order of arrival decides nothing (stories 12, 13, 14, 21, 24)", () => {
  it("invoice first, then its Receipt: both connected, linked, the Receipt as `paired`", async () => {
    await arrive("f-invoice", invoiceFields);
    expect((await file("f-invoice")).transactionIds).toEqual(["t-gh"]);

    await arrive("f-receipt", receiptFields);
    const receipt = await file("f-receipt");
    expect(receipt.receiptLink).toMatchObject({ fileId: "f-invoice", setBy: "auto" });
    expect(receipt.transactionIds).toEqual(["t-gh"]);
    expect(await connectionOf("f-receipt", "t-gh")).toMatchObject({ origin: "auto", autoConnectReason: "paired" });
    // Never a Copy, recorded or suggested (story 27).
    expect(receipt.copyOfFileId ?? null).toBeNull();
    expect(receipt.copySuggestion ?? null).toBeNull();
    // Counted once (story 2).
    expect((await loadDocumentedAmounts(["t-gh"])).get("t-gh")).toBe(2000);
  });

  it("the Receipt first, then its invoice: the invoice follows past the covered Transaction", async () => {
    await arrive("f-receipt", receiptFields);
    expect((await file("f-receipt")).transactionIds).toEqual(["t-gh"]);

    await arrive("f-invoice", invoiceFields);
    expect((await file("f-receipt")).receiptLink).toMatchObject({ fileId: "f-invoice", setBy: "auto" });
    expect((await file("f-invoice")).transactionIds).toEqual(["t-gh"]);
    expect(await connectionOf("f-invoice", "t-gh")).toMatchObject({ origin: "auto", autoConnectReason: "paired" });
    expect((await file("f-invoice")).copyOfFileId ?? null).toBeNull();
    expect((await loadDocumentedAmounts(["t-gh"])).get("t-gh")).toBe(2000);
  });

  it("connecting either File of a linked pair later brings the other along, and never moves one (stories 21, 23)", async () => {
    await seedFile("f-invoice", invoiceFields);
    await seedFile("f-receipt", { ...receiptFields, receiptLink: { fileId: "f-invoice", setBy: "manual" } });
    await seedFile("f-slip", { extractedAmount: 2000, receiptLink: { fileId: "f-invoice", setBy: "manual" }, transactionIds: ["t-elsewhere"] });

    await connectFile(db as never, USER, { fileId: "f-invoice", transactionId: "t-gh" }, { origin: "manual" });
    expect((await file("f-receipt")).transactionIds).toEqual(["t-gh"]);
    expect(await connectionOf("f-receipt", "t-gh")).toMatchObject({ origin: "auto", autoConnectReason: "paired" });
    // Already connected elsewhere: nothing moves.
    expect((await file("f-slip")).transactionIds).toEqual(["t-elsewhere"]);
  });

  it("an Unlink of one File leaves the other connected, and nothing re-connects it (story 25)", async () => {
    await arrive("f-invoice", invoiceFields);
    await arrive("f-receipt", receiptFields);
    await unlinkFile(db as never, USER, { fileId: "f-receipt", transactionId: "t-gh" });
    await drainTriggers();

    expect((await file("f-receipt")).transactionIds).toEqual([]);
    expect((await file("f-invoice")).transactionIds).toEqual(["t-gh"]);
    // The link stays until a person removes it (rule 5).
    expect((await file("f-receipt")).receiptLink).toMatchObject({ fileId: "f-invoice" });
  });
});

describe("the pair check (stories 15, 16, 18, 23, 43, 44)", () => {
  it("records a link on a cited number only when the issuer agrees", async () => {
    await seedFile("f-invoice", { ...invoiceFields, extractedIssuer: { name: "Stripe, Inc.", vatId: "EU111" } });
    await seedFile("f-receipt", receiptFields);
    const outcome = await runReceiptPairCheck(db as never, "f-receipt", await file("f-receipt"));
    expect(outcome.linked).toEqual([]);
    expect((await file("f-receipt")).receiptLink ?? null).toBeNull();
  });

  it("never links to or suggests another user's File", async () => {
    await seedFile("f-theirs", invoiceFields, OTHER);
    await seedFile("f-receipt", receiptFields);
    const outcome = await runReceiptPairCheck(db as never, "f-receipt", await file("f-receipt"));
    expect(outcome).toMatchObject({ linked: [], suggested: [] });
  });

  it("suggests on Partner, day and a Receipt at or above the invoice; amount alone never", async () => {
    await seedFile("f-rechnung", { extractedAmount: 5080, documentType: "invoice", extractedIssuer: { name: "Gasthaus" } });
    await seedFile("f-slip", { extractedAmount: 5500, documentType: "receipt", extractedIssuer: { name: "Gasthaus" } });
    await seedFile("f-elsewhere", { partnerId: "p-other", extractedAmount: 5500, documentType: "receipt" });

    const outcome = await runReceiptPairCheck(db as never, "f-slip", await file("f-slip"));
    expect(outcome).toMatchObject({ linked: [], suggested: ["f-rechnung"] });
    expect((await file("f-rechnung")).receiptPairSuggestions.map((s: { fileId: string }) => s.fileId)).toEqual(["f-slip"]);

    // A slip below the Rechnung's total is no Receipt of it.
    await db.collection("files").doc("f-slip").update({ extractedAmount: 4000 });
    expect((await runReceiptPairCheck(db as never, "f-slip", await file("f-slip"))).suggested).toEqual([]);
    expect((await file("f-rechnung")).receiptPairSuggestions).toEqual([]);

    // Another Partner's File of the same amount is never offered.
    expect((await runReceiptPairCheck(db as never, "f-elsewhere", await file("f-elsewhere"))).suggested).toEqual([]);
  });

  it("never suggests a declined pair again", async () => {
    await seedFile("f-rechnung", { extractedAmount: 5080, documentType: "invoice" });
    await seedFile("f-slip", { extractedAmount: 5500, documentType: "receipt" });
    await runReceiptPairCheck(db as never, "f-slip", await file("f-slip"));
    const r = await unlinkReceipt(db as never, USER, { fileId: "f-rechnung", otherFileId: "f-slip" });
    expect(r).toMatchObject({ outcome: "declined", declinedFileId: "f-slip" });
    expect((await file("f-slip")).receiptPairDeclinedFileIds).toEqual(["f-rechnung"]);
    expect((await runReceiptPairCheck(db as never, "f-slip", await file("f-slip"))).suggested).toEqual([]);
  });

  it("only suggests a pair whose Files sit on different Transactions, and moves nothing", async () => {
    await seedFile("f-invoice", { ...invoiceFields, transactionIds: ["t-1"] });
    await seedFile("f-receipt", { ...receiptFields, transactionIds: ["t-2"] });
    const outcome = await runReceiptPairCheck(db as never, "f-receipt", await file("f-receipt"));
    expect(outcome).toMatchObject({ linked: [], suggested: ["f-invoice"], connectedFileIds: [] });
    expect((await file("f-receipt")).receiptLink ?? null).toBeNull();
    expect((await file("f-receipt")).transactionIds).toEqual(["t-2"]);
    expect((await file("f-invoice")).transactionIds).toEqual(["t-1"]);
  });

  it("re-decides an automatic link on re-extraction and leaves a person's standing", async () => {
    await arrive("f-invoice", invoiceFields);
    await arrive("f-receipt", receiptFields);
    await seedFile("f-other-invoice", { extractedInvoiceNumber: "INV-2" });

    await db.collection("files").doc("f-receipt").update({ extractedPaidInvoiceNumber: "INV-2" });
    await drainTriggers();
    expect((await file("f-receipt")).receiptLink).toMatchObject({ fileId: "f-other-invoice", setBy: "auto" });

    await linkReceipt(db as never, USER, { fileId: "f-receipt", invoiceFileId: "f-invoice" });
    await db.collection("files").doc("f-receipt").update({ extractedPaidInvoiceNumber: "INV-9" });
    await drainTriggers();
    expect((await file("f-receipt")).receiptLink).toMatchObject({ fileId: "f-invoice", setBy: "manual" });
  });
});

describe("a person's acts, through the callables (stories 17, 19, 20, 28, 31, 38)", () => {
  it("accepts a suggestion, which connects the other File to the line, and shows the pair from both sides", async () => {
    await seedFile("f-rechnung", { extractedAmount: 5080, documentType: "invoice" });
    await seedFile("f-slip", { extractedAmount: 5500, documentType: "receipt" });
    await db.collection("transactions").doc("t-meal").set({ userId: USER, date: day("2026-07-01"), amount: -5500, fileIds: [] });
    await connectFile(db as never, USER, { fileId: "f-slip", transactionId: "t-meal" }, { origin: "manual" });
    await runReceiptPairCheck(db as never, "f-slip", await file("f-slip"));

    const view = (await getReceiptLinkCallable.run({ data: { fileId: "f-slip" }, auth } as never)) as Awaited<
      ReturnType<typeof getReceiptLink>
    >;
    expect(view.suggestions).toEqual([expect.objectContaining({ fileId: "f-rechnung", suggestedReceiptId: "f-slip" })]);

    const r = await linkReceiptCallable.run({ data: { fileId: "f-slip", invoiceFileId: "f-rechnung" }, auth } as never);
    expect(r).toMatchObject({ setBy: "suggested-accepted", connectedFileId: "f-rechnung" });
    expect((await file("f-rechnung")).transactionIds).toEqual(["t-meal"]);
    expect(await connectionOf("f-rechnung", "t-meal")).toMatchObject({ origin: "auto", autoConnectReason: "paired" });
    // The tip on the slip closes the line: counted once, to the bank amount.
    expect((await loadDocumentedAmounts(["t-meal"])).get("t-meal")).toBe(5500);

    const invoiceView = await getReceiptLink(db as never, USER, { fileId: "f-rechnung" });
    expect(invoiceView.receipts).toEqual([expect.objectContaining({ fileId: "f-slip", setBy: "suggested-accepted" })]);
    expect(invoiceView.suggestions).toEqual([]);
  });

  it("unlinks, records it as declined on both Files, and the check never links the pair again", async () => {
    await seedFile("f-invoice", invoiceFields);
    await seedFile("f-receipt", receiptFields);
    await runReceiptPairCheck(db as never, "f-receipt", await file("f-receipt"));
    expect((await file("f-receipt")).receiptLink).toMatchObject({ fileId: "f-invoice" });

    const r = await unlinkReceiptCallable.run({ data: { fileId: "f-receipt" }, auth } as never);
    expect(r).toMatchObject({ outcome: "unlinked", declinedFileId: "f-invoice" });
    expect((await file("f-invoice")).receiptPairDeclinedFileIds).toEqual(["f-receipt"]);
    expect((await runReceiptPairCheck(db as never, "f-receipt", await file("f-receipt"))).linked).toEqual([]);
  });

  it("refuses to link a live Copy, and to mark a linked pair as a Copy", async () => {
    await seedFile("f-invoice", invoiceFields);
    await seedFile("f-original", { extractedInvoiceNumber: "R-7" });
    await seedFile("f-copy", { extractedInvoiceNumber: "R-7", copyOfFileId: "f-original" });
    await expect(
      linkReceipt(db as never, USER, { fileId: "f-copy", invoiceFileId: "f-invoice" })
    ).rejects.toThrow(/Undo the Copy first/);

    await seedFile("f-receipt", { ...receiptFields, receiptLink: { fileId: "f-invoice", setBy: "manual" } });
    await expect(
      markFileAsCopy(db as never, USER, { fileId: "f-receipt", originalFileId: "f-invoice" })
    ).rejects.toThrow(/never a Copy/);
  });

  it("refuses another user's File as the invoice, as if it did not exist", async () => {
    await seedFile("f-theirs", invoiceFields, OTHER);
    await seedFile("f-receipt", receiptFields);
    await expect(
      linkReceiptCallable.run({ data: { fileId: "f-receipt", invoiceFileId: "f-theirs" }, auth } as never)
    ).rejects.toThrow(/not found/i);
  });

  it("the backfill only suggests, even where a cited number would link", async () => {
    await seedFile("f-invoice", invoiceFields);
    await seedFile("f-receipt", receiptFields);
    const r = await backfillReceiptPairsCallable.run({ data: {}, auth } as never);
    expect(r).toEqual({ success: true, files: 2, suggested: 2 });
    expect((await file("f-receipt")).receiptLink ?? null).toBeNull();
    expect((await file("f-receipt")).receiptPairSuggestions.map((s: { fileId: string }) => s.fileId)).toEqual([
      "f-invoice",
    ]);
    // Safe to run again.
    expect(await backfillReceiptPairsCallable.run({ data: {}, auth } as never)).toEqual({
      success: true,
      files: 2,
      suggested: 2,
    });
  });
});
