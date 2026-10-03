/**
 * #133: Cancel issues an Invoice Correction, run against the Postgres-backed shim.
 *
 * The original and its File stay on record (BAO § 132). The correction is a
 * new invoice with its own next number, the original's lines negated, and a
 * link each way, so the UVA sees +VAT and −VAT instead of a hole.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { performCancelInvoice } from "../invoicing/cancelInvoice";
import { performUndoIssueInvoice } from "../invoicing/undoIssueInvoice";
import { performDeleteInvoice } from "../invoicing/deleteInvoice";
import { computeInvoiceTotals, Invoice, InvoiceLineItem } from "../invoicing/types";
import { buildInvoiceFileFields } from "../invoicing/buildInvoiceFileFields";

const db = getFirestore() as unknown as FirebaseFirestore.Firestore;
const USER = "u1";
const YEAR = new Date().getFullYear();

const LINES: InvoiceLineItem[] = [
  { id: "l1", description: "Beratung", quantity: 1.5, unitPrice: 3333, vatRate: 20 },
  { id: "l2", description: "Buch", quantity: 2, unitPrice: 1999, vatRate: 10 },
];

async function issued(id: string, seq: number, extra: Record<string, unknown> = {}) {
  const totals = computeInvoiceTotals(LINES);
  await db.collection("invoices").doc(id).set({
    userId: USER,
    status: "issued",
    namePrefix: "RE",
    number: `RE-${YEAR}-${String(seq).padStart(4, "0")}`,
    numberSeq: seq,
    issuer: { entityId: "e1", name: "Stefan EPU", iban: "AT611904300234573201" },
    recipient: { partnerId: "p1", partnerType: "user", name: "Kunde GmbH" },
    issueDate: Timestamp.fromDate(new Date(Date.UTC(YEAR, 0, 10))),
    dueDate: Timestamp.fromDate(new Date(Date.UTC(YEAR, 0, 24))),
    paymentTerms: "Zahlbar innerhalb von 14 Tagen",
    lineItems: LINES,
    currency: "EUR",
    ...totals,
    issuedAt: Timestamp.now(),
    fileId: `file-${id}`,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
  await db.collection("files").doc(`file-${id}`).set({
    userId: USER,
    fileName: `RE-${YEAR}-${seq}.pdf`,
    isFibukiGenerated: true,
    invoiceId: id,
    invoiceDirection: "outgoing",
    extractedAmount: totals.total,
    transactionIds: [],
  });
}

let rendered: Invoice[];
let failRender: boolean;
const deps = () => ({
  renderPdf: vi.fn(async (invoice: Invoice) => {
    if (failRender) throw new Error("render failed");
    rendered.push(invoice);
    return Buffer.from("%PDF");
  }),
  storeDocument: vi.fn(async (path: string) => `https://storage.example/${path}`),
});

const cancel = (invoiceId: string, userId = USER) =>
  performCancelInvoice(db, userId, { invoiceId }, deps());

const invoice = async (id: string) => (await db.collection("invoices").doc(id).get()).data()!;
const file = async (id: string) => (await db.collection("files").doc(id).get()).data()!;

beforeEach(async () => {
  await __resetFirestoreShim();
  rendered = [];
  failRender = false;
});

describe("performCancelInvoice", () => {
  it("issues an Invoice Correction with its own next number and the lines negated", async () => {
    await issued("inv17", 17);
    await issued("inv18", 18);

    const res = await cancel("inv17");

    expect(res).toMatchObject({
      success: true,
      invoiceId: "inv17",
      status: "cancelled",
      correctionNumber: `RE-${YEAR}-0019`,
    });
    const correction = await invoice(res.correctionInvoiceId);
    expect(correction.status).toBe("issued");
    expect(correction.numberSeq).toBe(19);
    expect(correction.correctsInvoice).toMatchObject({ invoiceId: "inv17", number: `RE-${YEAR}-0017` });
    expect(correction.recipient.partnerId).toBe("p1");
    expect(correction.lineItems.map((li: InvoiceLineItem) => li.unitPrice)).toEqual([-3333, -1999]);

    const original = await invoice("inv17");
    expect(correction.subtotal).toBe(-original.subtotal);
    expect(correction.vatAmount).toBe(-original.vatAmount);
    expect(correction.total).toBe(-original.total);
    // The negated lines add up to the reversed totals, half-cent lines included.
    expect(computeInvoiceTotals(correction.lineItems)).toEqual({
      subtotal: -original.subtotal,
      vatAmount: -original.vatAmount,
      total: -original.total,
    });

    // The PDF was rendered from the correction, reference included.
    expect(rendered).toHaveLength(1);
    expect(rendered[0].correctsInvoice?.number).toBe(`RE-${YEAR}-0017`);
  });

  it("keeps the original and its File on record, linked to the correction", async () => {
    await issued("inv1", 1);

    const res = await cancel("inv1");

    const original = await invoice("inv1");
    expect(original.status).toBe("cancelled");
    expect(original.cancelledAt).toBeInstanceOf(Timestamp);
    expect(original.correctedByInvoiceId).toBe(res.correctionInvoiceId);
    const originalFile = await file("file-inv1");
    expect(originalFile.deletedAt).toBeUndefined();
    expect(originalFile.extractedAmount).toBe(original.total);
  });

  it("gives the correction a File that enters the pipeline like any issued invoice's", async () => {
    await issued("inv1", 1);

    const res = await cancel("inv1");

    const correctionFile = await file(res.correctionFileId);
    const original = await invoice("inv1");
    expect(correctionFile).toMatchObject({
      userId: USER,
      invoiceId: res.correctionInvoiceId,
      invoiceDirection: "outgoing",
      isFibukiGenerated: true,
      extractionComplete: true,
      extractedAmount: -original.total,
      extractedVatAmount: -original.vatAmount,
      fileName: `RE-${YEAR}-0002.pdf`,
      transactionIds: [],
    });
    expect(correctionFile.deletedAt).toBeUndefined();
    // Line by line, the correction's File reverses exactly what the original's states.
    const originalLines = buildInvoiceFileFields({ ...original, id: "inv1" } as Invoice, {
      storagePath: "",
      downloadUrl: "",
      fileSize: 0,
    }).extractedLineItems as { amount: number; vatAmount: number }[];
    expect(correctionFile.extractedLineItems).toEqual(
      originalLines.map((li) => ({ ...li, amount: -li.amount, vatAmount: -li.vatAmount })),
    );
  });

  it("cancels a paid invoice and keeps what paid it", async () => {
    await issued("inv1", 1, { status: "paid", paidByTransactionId: "t1", paidAt: Timestamp.now() });

    await cancel("inv1");

    const original = await invoice("inv1");
    expect(original.status).toBe("cancelled");
    expect(original.paidByTransactionId).toBe("t1");
  });

  it("refuses a draft, an already cancelled invoice and a correction", async () => {
    await issued("draft", 1, { status: "draft" });
    await expect(cancel("draft")).rejects.toThrow(/Only issued\/sent\/paid/);

    await issued("inv2", 2);
    const res = await cancel("inv2");
    await expect(cancel("inv2")).rejects.toThrow(/already cancelled by invoice RE-/);
    await expect(cancel(res.correctionInvoiceId)).rejects.toThrow(/correction cannot be cancelled/);

    const corrections = (await db.collection("invoices").where("userId", "==", USER).get()).docs.filter(
      (d) => d.data().correctsInvoice,
    );
    expect(corrections).toHaveLength(1);
  });

  it("refuses another user's invoice", async () => {
    await issued("inv1", 1);
    await expect(cancel("inv1", "u2")).rejects.toThrow(/Not your invoice/);
    expect((await invoice("inv1")).status).toBe("issued");
  });

  it("finishes a cancel whose correction was never issued when called again", async () => {
    await issued("inv1", 1);
    failRender = true;
    await expect(cancel("inv1")).rejects.toThrow(/render failed/);

    const pending = await invoice("inv1");
    expect(pending.status).toBe("cancelled");
    expect((await invoice(pending.correctedByInvoiceId)).status).toBe("draft");

    failRender = false;
    const res = await cancel("inv1");
    expect(res.correctionInvoiceId).toBe(pending.correctedByInvoiceId);
    expect((await invoice(res.correctionInvoiceId)).status).toBe("issued");
  });

  it("is taken back by undoing the correction and discarding its draft", async () => {
    await issued("inv1", 1, { status: "sent", sentVia: "manual", sentAt: Timestamp.now() });
    const res = await cancel("inv1");

    await performUndoIssueInvoice(db, USER, { invoiceId: res.correctionInvoiceId }, {
      deleteStoredDocument: async () => undefined,
    });
    expect((await invoice(res.correctionInvoiceId)).status).toBe("draft");
    expect((await invoice("inv1")).status).toBe("cancelled");

    await performDeleteInvoice(db, USER, { invoiceId: res.correctionInvoiceId });

    const original = await invoice("inv1");
    expect(original.status).toBe("sent");
    expect(original.cancelledAt).toBeUndefined();
    expect(original.correctedByInvoiceId).toBeUndefined();
    expect((await db.collection("invoices").doc(res.correctionInvoiceId).get()).exists).toBe(false);
  });
});
