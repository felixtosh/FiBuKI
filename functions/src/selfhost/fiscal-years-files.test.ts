/**
 * Files and File Connections in the Closed stretch (#801, spec #800,
 * ADR-0018). A File dated in the Closed stretch keeps its facts and cannot be
 * deleted. A File Connection is locked when its Transaction is Closed; the
 * File's date does not lock a connection, so an invoice dated in a closed
 * year can still be connected to its payment in open time.
 *
 * Driven through the MCP tools and the callables against the self-host
 * in-memory database, asserting on what is stored.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/fiscal-years-files.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { updateFileExtractedFieldsCallable } from "../files/updateFileExtractedFields";
import { updateFileCallable } from "../files/updateFile";
import { assignPartnerToFileCallable } from "../files/filePartner";
import { markFileAsNotInvoiceCallable } from "../files/markFileAsNotInvoice";
import { deleteFileCallable } from "../files/deleteFile";
import { connectFileToTransactionCallable } from "../files/connectFileToTransaction";
import { disconnectFileFromTransactionCallable } from "../files/disconnectFileFromTransaction";
import { unrejectFileFromTransactionCallable } from "../files/unrejectFileFromTransaction";
import { markFileAsCopyCallable } from "../files/copyCallables";
import { connectFiles } from "../fileConnections/writer";

const db = getFirestore();
const USER = "fyf-user";
const AUTH = { uid: USER, token: {} };
const LOCK = /Closed Through is 2024-12.*move Closed Through back/;

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const call = (callable: unknown, data: Record<string, unknown>) =>
  (callable as { run: (r: unknown) => Promise<unknown> }).run({ data, auth: AUTH });

function closeThrough(closedThrough: string | null) {
  return handleTool(USER, "set_fiscal_years", { trackedFrom: "2023-01", closedThrough });
}

async function seedFile(id: string, iso: string | null, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: USER,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedDate: iso ? day(iso) : null,
    extractedAmount: 12000,
    extractedCurrency: "EUR",
    transactionIds: [],
    ...extra,
  });
}

async function seedTx(id: string, iso: string, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-1",
    date: day(iso),
    amount: -12000,
    currency: "EUR",
    name: "Vendor",
    fileIds: [],
    isComplete: false,
    ...extra,
  });
}

async function stored(collection: string, id: string): Promise<Record<string, any>> {
  return (await db.collection(collection).doc(id).get()).data()!;
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("a File dated in the Closed stretch keeps its facts", () => {
  beforeEach(async () => {
    await closeThrough("2024-12");
    await seedFile("f-closed", "2024-04-15");
    await seedFile("f-open", "2025-02-01");
  });

  it("update_file_extraction refuses a fact change, naming Closed Through and how to lift it", async () => {
    await expect(handleTool(USER, "update_file_extraction", { fileId: "f-closed", amount: 9900 })).rejects.toThrow(LOCK);
    expect((await stored("files", "f-closed")).extractedAmount).toBe(12000);
  });

  it("refuses the currency too", async () => {
    await expect(handleTool(USER, "update_file_extraction", { fileId: "f-closed", currency: "USD" })).rejects.toThrow(LOCK);
    expect((await stored("files", "f-closed")).extractedCurrency).toBe("EUR");
  });

  it("the panel's correction callable refuses the same", async () => {
    await expect(
      call(updateFileExtractedFieldsCallable, { fileId: "f-closed", correction: { amount: 9900 } })
    ).rejects.toMatchObject({ code: "failed-precondition", message: expect.stringMatching(LOCK) });
    expect((await stored("files", "f-closed")).extractedAmount).toBe(12000);
  });

  it("refuses moving an open File's date into the Closed stretch", async () => {
    await expect(handleTool(USER, "update_file_extraction", { fileId: "f-open", date: "2024-11-30" })).rejects.toThrow(LOCK);
    expect((await stored("files", "f-open")).extractedDate.toDate().toISOString().slice(0, 10)).toBe("2025-02-01");
  });

  it("leaves an open File's corrections alone", async () => {
    await handleTool(USER, "update_file_extraction", { fileId: "f-open", amount: 9900 });
    expect((await stored("files", "f-open")).extractedAmount).toBe(9900);
  });
});

describe("a Closed File's Partner and invoice ruling stay too", () => {
  beforeEach(async () => {
    await closeThrough("2024-12");
    await seedFile("f-closed", "2024-04-15");
    await db.collection("partners").doc("p-1").set({ userId: USER, name: "Billa" });
  });

  it("the tools refuse a Partner, its removal and the not-invoice ruling", async () => {
    await db.collection("files").doc("f-closed").update({ partnerId: "p-1", partnerType: "user", partnerMatchedBy: "manual" });
    for (const [tool, args] of [
      ["assign_partner_to_file", { fileId: "f-closed", partnerId: "p-1" }],
      ["remove_partner_from_file", { fileId: "f-closed" }],
      ["mark_file_as_not_invoice", { fileId: "f-closed", reason: "statement" }],
    ] as const) {
      await expect(handleTool(USER, tool, args), tool).rejects.toThrow(LOCK);
    }
    expect(await stored("files", "f-closed")).toMatchObject({ partnerId: "p-1", extractedAmount: 12000 });
    expect((await stored("files", "f-closed")).isNotInvoice).toBeUndefined();
  });

  it("the callables refuse the same", async () => {
    const calls: Array<[string, unknown, Record<string, unknown>]> = [
      ["assignPartner", assignPartnerToFileCallable, { fileId: "f-closed", partnerId: "p-1", partnerType: "user", matchedBy: "manual" }],
      ["updateFile partner", updateFileCallable, { fileId: "f-closed", data: { partnerId: "p-1", partnerType: "user", partnerMatchedBy: "manual" } }],
      ["updateFile direction", updateFileCallable, { fileId: "f-closed", data: { invoiceDirection: "outgoing" } }],
      ["notInvoice", markFileAsNotInvoiceCallable, { fileId: "f-closed", reason: "statement" }],
    ];
    for (const [name, callable, data] of calls) {
      await expect(call(callable, data), name).rejects.toMatchObject({ message: expect.stringMatching(LOCK) });
    }
    expect((await stored("files", "f-closed")).partnerId).toBeUndefined();
  });

  it("the recipient ruling stays: it decides whether the File's VAT is in the UVA", async () => {
    await seedFile("f-foreign", "2024-05-02", { foreignRecipient: true });
    await seedFile("f-confirmed", "2024-05-03", { recipientConfirmedAsUser: true });

    await expect(handleTool(USER, "confirm_file_recipient_is_user", { fileId: "f-foreign" })).rejects.toThrow(LOCK);
    await expect(handleTool(USER, "unconfirm_file_recipient_is_user", { fileId: "f-confirmed" })).rejects.toThrow(LOCK);

    expect(await stored("files", "f-foreign")).toMatchObject({ foreignRecipient: true });
    expect((await stored("files", "f-foreign")).recipientConfirmedAsUser).toBeUndefined();
    expect((await stored("files", "f-confirmed")).recipientConfirmedAsUser).toBe(true);
  });

  it("a Closed File is not marked as a Copy, by the tool or the callable", async () => {
    await seedFile("f-orig", "2025-01-09");

    await expect(handleTool(USER, "mark_file_as_copy", { fileId: "f-closed", originalFileId: "f-orig" })).rejects.toThrow(LOCK);
    await expect(call(markFileAsCopyCallable, { fileId: "f-closed", originalFileId: "f-orig" })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(LOCK),
    });
    expect((await stored("files", "f-closed")).copyOfFileId).toBeUndefined();
  });

  it("an open File is still marked as a Copy of a Closed one", async () => {
    await seedFile("f-open", "2025-01-09");

    await handleTool(USER, "mark_file_as_copy", { fileId: "f-open", originalFileId: "f-closed" });

    expect((await stored("files", "f-open")).copyOfFileId).toBe("f-closed");
  });

  it("a rename is not a fact: it still goes through", async () => {
    await call(updateFileCallable, { fileId: "f-closed", data: { fileName: "renamed.pdf" } });
    expect((await stored("files", "f-closed")).fileName).toBe("renamed.pdf");
  });
});

describe("a Closed File cannot be deleted", () => {
  beforeEach(async () => {
    await closeThrough("2024-12");
    await seedFile("f-closed", "2024-04-15");
  });

  it("delete_file and the deleteFile callable refuse it, and the File stays live", async () => {
    await expect(handleTool(USER, "delete_file", { fileId: "f-closed", confirm: true })).rejects.toThrow(LOCK);
    await expect(call(deleteFileCallable, { fileId: "f-closed" })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringMatching(LOCK),
    });
    expect((await stored("files", "f-closed")).deletedAt).toBeUndefined();
  });

  it("an open File connected to a Closed Transaction cannot be deleted either: its connection is locked", async () => {
    await seedFile("f-open", "2025-01-10", { transactionIds: ["tx-closed"] });
    await seedTx("tx-closed", "2024-12-20", { fileIds: ["f-open"], isComplete: true });

    await expect(handleTool(USER, "delete_file", { fileId: "f-open", confirm: true })).rejects.toThrow(LOCK);
    expect((await stored("files", "f-open")).deletedAt).toBeUndefined();
    expect((await stored("transactions", "tx-closed")).fileIds).toEqual(["f-open"]);
  });

  it("split_file refuses it before anything is written", async () => {
    await expect(handleTool(USER, "split_file", { fileId: "f-closed", ranges: [{ from: 1, to: 1 }, { from: 2, to: 2 }] })).rejects.toThrow(LOCK);
    const files = await db.collection("files").where("userId", "==", USER).get();
    expect(files.size).toBe(1);
  });
});

/** Whether the pair holds a File Connection: the record and both lists. */
async function connected(fileId: string, transactionId: string) {
  const [file, tx, records] = await Promise.all([
    stored("files", fileId),
    stored("transactions", transactionId),
    db.collection("fileConnections").where("userId", "==", USER).where("fileId", "==", fileId).get(),
  ]);
  const byRecord = records.docs.some((d) => d.data()?.transactionId === transactionId);
  const byFile = (file.transactionIds ?? []).includes(transactionId);
  const byTx = (tx.fileIds ?? []).includes(fileId);
  expect({ byFile, byTx }).toEqual({ byFile: byRecord, byTx: byRecord });
  return byRecord;
}

describe("a File Connection is locked when its Transaction is Closed", () => {
  beforeEach(async () => {
    await closeThrough("2024-12");
    await seedFile("f-open", "2025-01-10");
    await seedTx("tx-closed", "2024-12-20");
  });

  it("connect_file_to_transaction and the connect callable refuse it", async () => {
    await expect(handleTool(USER, "connect_file_to_transaction", { fileId: "f-open", transactionId: "tx-closed" })).rejects.toThrow(LOCK);
    await expect(
      call(connectFileToTransactionCallable, { fileId: "f-open", transactionId: "tx-closed" })
    ).rejects.toMatchObject({ code: "failed-precondition", message: expect.stringMatching(LOCK) });
    expect(await connected("f-open", "tx-closed")).toBe(false);
  });

  it("an automated connect is refused too, by reason", async () => {
    const [outcome] = await connectFiles(db as never, USER, [{ fileId: "f-open", transactionId: "tx-closed" }], { origin: "auto" });
    expect(outcome).toMatchObject({ status: "refused", reason: "closed", message: expect.stringMatching(LOCK) });
    expect(await connected("f-open", "tx-closed")).toBe(false);
  });

  it("an Unlink and a Rejection are refused, and the connection stays", async () => {
    await closeThrough(null);
    await handleTool(USER, "connect_file_to_transaction", { fileId: "f-open", transactionId: "tx-closed" });
    await closeThrough("2024-12");

    await expect(handleTool(USER, "disconnect_file_from_transaction", { fileId: "f-open", transactionId: "tx-closed" })).rejects.toThrow(LOCK);
    await expect(
      call(disconnectFileFromTransactionCallable, { fileId: "f-open", transactionId: "tx-closed", rejectFile: true })
    ).rejects.toMatchObject({ code: "failed-precondition", message: expect.stringMatching(LOCK) });
    expect(await connected("f-open", "tx-closed")).toBe(true);
    expect((await stored("transactions", "tx-closed")).rejectedFileIds).toBeUndefined();
  });

  it("lifting a Rejection is refused too", async () => {
    await db.collection("transactions").doc("tx-closed").update({
      rejectedFileIds: ["f-open"],
      rejectedFiles: [{ fileId: "f-open", rejectedAt: day("2025-01-11") }],
    });
    await expect(
      call(unrejectFileFromTransactionCallable, { fileId: "f-open", transactionId: "tx-closed" })
    ).rejects.toMatchObject({ message: expect.stringMatching(LOCK) });
    expect((await stored("transactions", "tx-closed")).rejectedFileIds).toEqual(["f-open"]);
  });

  it("marking a connected File as a Copy would move a locked connection: refused", async () => {
    await seedFile("f-orig", "2025-01-09");
    await closeThrough(null);
    await handleTool(USER, "connect_file_to_transaction", { fileId: "f-open", transactionId: "tx-closed" });
    await closeThrough("2024-12");

    await expect(call(markFileAsCopyCallable, { fileId: "f-open", originalFileId: "f-orig" })).rejects.toMatchObject({
      message: expect.stringMatching(LOCK),
    });
    expect(await connected("f-open", "tx-closed")).toBe(true);
    expect((await stored("files", "f-open")).copyOfFileId).toBeUndefined();
  });
});

describe("a Closed File connects to a Transaction in open time", () => {
  beforeEach(async () => {
    await closeThrough("2024-12");
    await seedFile("f-april", "2024-04-15");
    await seedTx("tx-may", "2025-05-02");
  });

  it("connects and unlinks, while its own facts stay locked throughout", async () => {
    await handleTool(USER, "connect_file_to_transaction", { fileId: "f-april", transactionId: "tx-may" });
    expect(await connected("f-april", "tx-may")).toBe(true);

    await expect(handleTool(USER, "update_file_extraction", { fileId: "f-april", amount: 9900 })).rejects.toThrow(LOCK);
    await expect(handleTool(USER, "delete_file", { fileId: "f-april", confirm: true })).rejects.toThrow(LOCK);

    await handleTool(USER, "disconnect_file_from_transaction", { fileId: "f-april", transactionId: "tx-may" });
    expect(await connected("f-april", "tx-may")).toBe(false);
    expect((await stored("files", "f-april")).extractedAmount).toBe(12000);
  });
});

describe("inserts into the Closed stretch are not refused", () => {
  it("upload_file with a date in the Closed stretch stores the File", async () => {
    await closeThrough("2024-12");
    const { fileId } = (await handleTool(USER, "upload_file", {
      fileName: "beleg-2024.pdf",
      mimeType: "application/pdf",
      base64: Buffer.from("%PDF-1.4 closed upload").toString("base64"),
      date: "2024-03-15",
      amount: 4500,
      currency: "EUR",
    })) as { fileId: string };
    const file = await stored("files", fileId);
    expect(file.extractedDate.toDate().toISOString().slice(0, 10)).toBe("2024-03-15");
    expect(file.extractedAmount).toBe(4500);
  });
});

describe("after Closed Through is moved back, the refused writes succeed", () => {
  it("a correction, a connect, an Unlink and a delete", async () => {
    await closeThrough("2024-12");
    await seedFile("f-closed", "2024-04-15");
    await seedTx("tx-closed", "2024-12-20");
    await closeThrough("2024-03");

    await handleTool(USER, "update_file_extraction", { fileId: "f-closed", amount: 9900, currency: "USD" });
    expect(await stored("files", "f-closed")).toMatchObject({ extractedAmount: 9900, extractedCurrency: "USD" });

    await handleTool(USER, "connect_file_to_transaction", { fileId: "f-closed", transactionId: "tx-closed" });
    expect(await connected("f-closed", "tx-closed")).toBe(true);
    await handleTool(USER, "disconnect_file_from_transaction", { fileId: "f-closed", transactionId: "tx-closed" });
    expect(await connected("f-closed", "tx-closed")).toBe(false);

    await handleTool(USER, "delete_file", { fileId: "f-closed", confirm: true });
    expect((await stored("files", "f-closed")).deletedAt).toBeDefined();
  });
});
