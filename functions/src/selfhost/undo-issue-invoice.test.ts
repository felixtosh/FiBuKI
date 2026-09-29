/**
 * #272: un-issuing a misclicked invoice, run against the Postgres-backed shim.
 *
 * Undo is the narrow exception ADR-0006 records: allowed only while the
 * invoice is still the highest issued number of the current year and nobody
 * outside can hold a copy (never sent, never opened by link, never paid).
 * Everything else stays Storno via cancel_invoice.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { performUndoIssueInvoice } from "../invoicing/undoIssueInvoice";

const db = getFirestore();
const USER = "u1";
const YEAR = new Date().getFullYear();

function issueDate(year = YEAR) {
  return Timestamp.fromDate(new Date(Date.UTC(year, 5, 15)));
}

async function issued(id: string, seq: number, extra: Record<string, unknown> = {}) {
  await db.collection("invoices").doc(id).set({
    userId: USER,
    status: "issued",
    number: `RE-${YEAR}-${String(seq).padStart(4, "0")}`,
    numberSeq: seq,
    issueDate: issueDate(),
    issuedAt: Timestamp.now(),
    fileId: `file-${id}`,
    ...extra,
  });
  await db.collection("files").doc(`file-${id}`).set({
    userId: USER,
    fileName: `RE-${YEAR}-${seq}.pdf`,
    storagePath: `files/${USER}/invoices/${id}_v1.pdf`,
    downloadUrl: "https://storage.example/x.pdf",
    fileSize: 1234,
    extractedAmount: 12000,
    isFibukiGenerated: true,
    invoiceId: id,
    transactionIds: [],
    transactionSuggestions: [{ transactionId: "t9", confidence: 70 }],
  });
}

let deleted: string[];
const deps = () => ({
  deleteStoredDocument: vi.fn(async (path: string) => {
    deleted.push(path);
  }),
});

async function undo(invoiceId: string, userId = USER) {
  return performUndoIssueInvoice(db as unknown as FirebaseFirestore.Firestore, userId, { invoiceId }, deps());
}

async function refused(invoiceId: string, pattern: RegExp) {
  await expect(undo(invoiceId)).rejects.toThrow(pattern);
  const inv = (await db.collection("invoices").doc(invoiceId).get()).data()!;
  expect(inv.status).not.toBe("draft");
  expect(deleted).toEqual([]);
}

beforeEach(async () => {
  await __resetFirestoreShim();
  deleted = [];
});

describe("performUndoIssueInvoice", () => {
  it("returns the newest issued invoice to an editable draft and destroys its document", async () => {
    await issued("inv1", 41);

    const res = await undo("inv1");

    expect(res).toEqual({ success: true, invoiceId: "inv1", status: "draft", numberSeq: 41 });
    const inv = (await db.collection("invoices").doc("inv1").get()).data()!;
    expect(inv.status).toBe("draft");
    expect(inv.numberSeq).toBe(41);
    expect(inv.number).toMatch(/^DRAFT-/);
    expect(inv.issuedAt).toBeUndefined();
    expect(deleted).toEqual([`files/${USER}/invoices/inv1_v1.pdf`]);

    const file = (await db.collection("files").doc("file-inv1").get()).data()!;
    expect(file.fileName).toBe("Rechnungsentwurf");
    expect(file.storagePath).toBe("");
    expect(file.downloadUrl).toBe("");
    expect(file.fileSize).toBe(0);
    expect(file.extractedAmount).toBeUndefined();
    expect(file.transactionSuggestions).toBeUndefined();
    expect(file.invoiceId).toBe("inv1");
  });

  it("refuses when a later invoice of the year was already issued", async () => {
    await issued("inv1", 41);
    await issued("inv2", 42);
    await refused("inv1", /newest|Storno|cancel_invoice/);
  });

  it("ignores later drafts: they hold no frozen number", async () => {
    await issued("inv1", 41);
    await db.collection("invoices").doc("draft").set({
      userId: USER,
      status: "draft",
      numberSeq: 42,
      issueDate: issueDate(),
    });
    await expect(undo("inv1")).resolves.toMatchObject({ status: "draft" });
  });

  it("refuses an invoice from an earlier year", async () => {
    await issued("inv1", 7, { issueDate: issueDate(YEAR - 1), number: `RE-${YEAR - 1}-0007` });
    await refused("inv1", /year/);
  });

  it("refuses a sent invoice", async () => {
    await issued("inv1", 41, { sentAt: Timestamp.now(), sentVia: "manual" });
    await refused("inv1", /sent/);
  });

  it("refuses an invoice that is not in the issued state", async () => {
    await issued("inv1", 41, { status: "paid" });
    await refused("inv1", /issued/);
  });

  it("refuses an invoice whose document is connected to a Transaction", async () => {
    await issued("inv1", 41);
    await db.collection("files").doc("file-inv1").update({ transactionIds: ["t1"] });
    await refused("inv1", /Transaction|paid/);
  });

  it("refuses once any share link of the invoice was opened, even a revoked one", async () => {
    await issued("inv1", 41);
    await db.collection("invoiceShares").doc("old").set({
      token: "old",
      invoiceId: "inv1",
      userId: USER,
      accessCount: 1,
      revokedAt: Timestamp.now(),
    });
    await refused("inv1", /opened|link/);
  });

  it("revokes an unopened share link as part of the undo", async () => {
    await issued("inv1", 41, { shareToken: "tok" });
    await db.collection("invoiceShares").doc("tok").set({
      token: "tok",
      invoiceId: "inv1",
      userId: USER,
      accessCount: 0,
    });

    await undo("inv1");

    const share = (await db.collection("invoiceShares").doc("tok").get()).data()!;
    expect(share.revokedAt).toBeDefined();
    const inv = (await db.collection("invoices").doc("inv1").get()).data()!;
    expect(inv.shareToken).toBeUndefined();
  });

  it("refuses an invoice numbered by the legacy allocator", async () => {
    await issued("inv1", 41, { numberSeq: null, number: `${YEAR}-0041` });
    await refused("inv1", /cancel_invoice/);
  });

  it("refuses another user's invoice", async () => {
    await issued("inv1", 41);
    await expect(undo("inv1", "someone-else")).rejects.toThrow(/Not your invoice/);
    expect(deleted).toEqual([]);
  });
});
