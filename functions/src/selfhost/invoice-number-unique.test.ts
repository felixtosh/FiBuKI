/**
 * An issued invoice number identifies one invoice (§ 11 Abs 1 Z 5 UStG),
 * run against the Postgres-backed shim.
 *
 * Issue, renumber and the Invoice Correction a Cancel issues all claim the
 * number through one per-user lock, so even two at the same moment cannot end
 * up holding the same number.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { performIssueInvoice } from "../invoicing/issueInvoice";
import { performUpdateInvoice } from "../invoicing/updateInvoice";
import { performCancelInvoice } from "../invoicing/cancelInvoice";
import { computeInvoiceTotals, Invoice, InvoiceLineItem } from "../invoicing/types";

const db = getFirestore() as unknown as FirebaseFirestore.Firestore;
const USER = "u1";
const YEAR = new Date().getFullYear();
const LINES: InvoiceLineItem[] = [{ id: "l1", description: "Beratung", quantity: 1, unitPrice: 10000, vatRate: 20 }];

const numberOf = (seq: number) => `RE-${YEAR}-${String(seq).padStart(4, "0")}`;

async function invoice(id: string, seq: number, status: Invoice["status"], extra: Record<string, unknown> = {}) {
  await db.collection("invoices").doc(id).set({
    userId: USER,
    status,
    namePrefix: "RE",
    number: status === "draft" ? `DRAFT-${id}` : numberOf(seq),
    numberSeq: seq,
    issuer: { entityId: "e1", name: "Stefan EPU", iban: "AT611904300234573201" },
    recipient: { partnerId: "p1", partnerType: "user", name: "Kunde GmbH" },
    issueDate: Timestamp.fromDate(new Date(Date.UTC(YEAR, 0, 10))),
    dueDate: Timestamp.fromDate(new Date(Date.UTC(YEAR, 0, 24))),
    paymentTerms: "Zahlbar innerhalb von 14 Tagen",
    lineItems: LINES,
    currency: "EUR",
    ...computeInvoiceTotals(LINES),
    fileId: `file-${id}`,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
  await db.collection("files").doc(`file-${id}`).set({
    userId: USER,
    fileName: "Rechnungsentwurf",
    isFibukiGenerated: true,
    invoiceId: id,
    extractionComplete: true,
    transactionIds: [],
  });
}

let failRender: boolean;
let renders: number;
const deps = () => ({
  renderPdf: vi.fn(async () => {
    renders++;
    if (failRender) throw new Error("render failed");
    return Buffer.from("%PDF");
  }),
  storeDocument: vi.fn(async (path: string) => `https://storage.example/${path}`),
});

const issue = (invoiceId: string) => performIssueInvoice(db, USER, { invoiceId }, deps());
const read = async (id: string) => (await db.collection("invoices").doc(id).get()).data()!;

beforeEach(async () => {
  await __resetFirestoreShim();
  failRender = false;
  renders = 0;
});

describe("issuing", () => {
  it("refuses a number another issued invoice holds, before anything is rendered", async () => {
    await invoice("a", 5, "issued");
    await invoice("b", 5, "draft");

    await expect(issue("b")).rejects.toThrow(/RE-\d{4}-0005 is already used/);

    const b = await read("b");
    expect(b.status).toBe("draft");
    expect(b.number).toBe("DRAFT-b");
    expect(renders).toBe(0);
  });

  it("counts a cancelled invoice's number as taken", async () => {
    await invoice("a", 5, "cancelled");
    await invoice("b", 5, "draft");

    await expect(issue("b")).rejects.toThrow(/already used/);
  });

  it("does not count a draft that happens to share the sequence", async () => {
    await invoice("a", 5, "draft");
    await invoice("b", 5, "draft");

    await issue("b");

    expect((await read("b")).number).toBe(numberOf(5));
  });

  it("gives the number back when rendering fails", async () => {
    await invoice("b", 5, "draft");
    failRender = true;

    await expect(issue("b")).rejects.toThrow(/render failed/);

    const b = await read("b");
    expect(b.status).toBe("draft");
    expect(b.number).toBe("DRAFT-b");
    expect(b.issuedAt).toBeUndefined();
    failRender = false;
    await invoice("c", 5, "draft");
    await issue("c");
    expect((await read("c")).number).toBe(numberOf(5));
  });

  it("lets only one of two drafts issued at the same moment take a number", async () => {
    await invoice("b", 7, "draft");
    await invoice("c", 7, "draft");

    const results = await Promise.allSettled([issue("b"), issue("c")]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const statuses = [(await read("b")).status, (await read("c")).status].sort();
    expect(statuses).toEqual(["draft", "issued"]);
  });
});

describe("renumbering an issued invoice", () => {
  const renumber = (invoiceId: string, numberSeq: number) =>
    performUpdateInvoice(db, USER, { invoiceId, patch: { numberSeq } });

  it("refuses a number another invoice holds and keeps its own", async () => {
    await invoice("a", 5, "issued");
    await invoice("b", 6, "sent");

    await expect(renumber("b", 5)).rejects.toThrow(/already used/);

    const b = await read("b");
    expect(b.number).toBe(numberOf(6));
    expect(b.numberSeq).toBe(6);
  });

  it("takes a free number", async () => {
    await invoice("a", 5, "issued");
    await invoice("b", 6, "paid");

    await renumber("b", 9);

    expect((await read("b")).number).toBe(numberOf(9));
  });
});

describe("the Invoice Correction a Cancel issues", () => {
  it("moves on to the next free number when two cancels pick the same one", async () => {
    await invoice("a", 1, "issued");
    await invoice("b", 2, "issued");

    const [ra, rb] = await Promise.all([
      performCancelInvoice(db, USER, { invoiceId: "a" }, deps()),
      performCancelInvoice(db, USER, { invoiceId: "b" }, deps()),
    ]);

    expect(ra.correctionNumber).not.toBe(rb.correctionNumber);
    expect([ra.correctionNumber, rb.correctionNumber].sort()).toEqual([numberOf(3), numberOf(4)]);
  });
});

describe("service, place of supply abroad (#565)", () => {
  const UK = { partnerId: "p1", partnerType: "user", name: "Michael Chaffe", address: { country: "GB" } };
  const ZERO = [{ ...LINES[0], vatRate: 0 }];
  const zeroRated = { lineItems: ZERO, ...computeInvoiceTotals(ZERO) };

  it("records the kind on the Invoice's File when issued", async () => {
    await invoice("a", 7, "draft", { supplyAbroad: true, recipient: UK, ...zeroRated });

    await issue("a");

    const file = (await db.collection("files").doc("file-a").get()).data()!;
    expect(file.invoiceSupplyKind).toBe("service-non-eu");
    expect(file.extractedVatAmount).toBe(0);
  });

  it("refuses to issue to an Austrian customer, before anything is rendered", async () => {
    await invoice("a", 7, "draft", {
      supplyAbroad: true,
      recipient: { ...UK, address: { country: "AT" } },
      ...zeroRated,
    });

    await expect(issue("a")).rejects.toThrow(/Austria/);
    expect((await read("a")).status).toBe("draft");
    expect(renders).toBe(0);
  });

  it("forces every line to 0% when the setting is turned on, and keeps it there", async () => {
    await invoice("a", 7, "draft", { recipient: UK });

    await performUpdateInvoice(db, USER, { invoiceId: "a", patch: { supplyAbroad: true } });
    let a = await read("a");
    expect(a.supplyAbroad).toBe(true);
    expect(a.lineItems.map((l: InvoiceLineItem) => l.vatRate)).toEqual([0]);
    expect(a.vatAmount).toBe(0);

    await performUpdateInvoice(db, USER, {
      invoiceId: "a",
      patch: { lineItems: [{ description: "More", quantity: 1, unitPrice: 5000, vatRate: 20 }] },
    });
    a = await read("a");
    expect(a.lineItems.map((l: InvoiceLineItem) => l.vatRate)).toEqual([0]);
    expect(a.total).toBe(5000);
  });

  it("refuses to turn it on for an issued invoice to an Austrian customer", async () => {
    await invoice("a", 7, "issued", { recipient: { ...UK, address: { country: "AT" } } });

    await expect(
      performUpdateInvoice(db, USER, { invoiceId: "a", patch: { supplyAbroad: true } })
    ).rejects.toThrow(/Austria/);
    expect((await read("a")).supplyAbroad).toBeUndefined();
  });

  it("carries the setting to the Invoice Correction", async () => {
    await invoice("a", 7, "draft", { supplyAbroad: true, recipient: UK, ...zeroRated });
    await issue("a");

    const { correctionInvoiceId } = await performCancelInvoice(db, USER, { invoiceId: "a" }, deps());

    expect((await read(correctionInvoiceId)).supplyAbroad).toBe(true);
  });
});
