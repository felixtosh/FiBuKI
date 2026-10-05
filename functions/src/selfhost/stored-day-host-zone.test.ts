/**
 * #673: Invoice numbers and due dates are the same whatever zone the host
 * runs in, run against the Postgres-backed shim.
 *
 * A stored date is UTC midnight of the Vienna calendar day. Read with the
 * host-zone getters, an Invoice issued on 1 January was numbered into the old
 * year west of UTC, and in Europe/Vienna a due date across the March clock
 * change came out a day early. "This year" and "today" are the Vienna day, so
 * at 23:30 UTC on New Year's Eve the new year has already begun.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { performCreateInvoice } from "../invoicing/createInvoice";
import { performUpdateInvoice } from "../invoicing/updateInvoice";
import { performDuplicateInvoice } from "../invoicing/duplicateInvoice";
import { performIssueInvoice } from "../invoicing/issueInvoice";
import { performCancelInvoice } from "../invoicing/cancelInvoice";
import { performUndoIssueInvoice } from "../invoicing/undoIssueInvoice";
import { computeInvoiceTotals, Invoice, InvoiceLineItem } from "../invoicing/types";

const db = getFirestore() as unknown as FirebaseFirestore.Firestore;
const USER = "u1";
const LINES: InvoiceLineItem[] = [{ id: "l1", description: "Beratung", quantity: 1, unitPrice: 10000, vatRate: 20 }];
const THIRTY_DAYS = "Zahlbar innerhalb von 30 Tagen";
/** 00:30 on 1 January 2027 in Vienna, still 2026 in UTC. */
const NEW_YEARS_NIGHT = new Date("2026-12-31T23:30:00Z");

const HOST_ZONES = ["UTC", "Europe/Vienna", "America/Los_Angeles", "Pacific/Kiritimati"];

/** UTC midnight of an ISO day, the way a stored date is written. */
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const isoOf = (value: unknown) => (value as Timestamp).toDate().toISOString();

async function invoice(id: string, seq: number, status: Invoice["status"], issueDate: string, extra: Record<string, unknown> = {}) {
  await db.collection("invoices").doc(id).set({
    userId: USER,
    status,
    namePrefix: "RE",
    number: status === "draft" ? `DRAFT-${id}` : `RE-${issueDate.slice(0, 4)}-${String(seq).padStart(4, "0")}`,
    numberSeq: seq,
    issuer: { entityId: "e1", name: "Stefan EPU", iban: "AT611904300234573201" },
    recipient: { partnerId: "p1", partnerType: "user", name: "Kunde GmbH" },
    issueDate: day(issueDate),
    dueDate: day(issueDate),
    paymentTerms: THIRTY_DAYS,
    lineItems: LINES,
    currency: "EUR",
    ...computeInvoiceTotals(LINES),
    fileId: `file-${id}`,
    ...(status === "draft" ? {} : { issuedAt: Timestamp.now() }),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...extra,
  });
  await db.collection("files").doc(`file-${id}`).set({
    userId: USER,
    fileName: "Rechnung",
    isFibukiGenerated: true,
    invoiceId: id,
    invoiceDirection: "outgoing",
    extractionComplete: true,
    transactionIds: [],
  });
}

const renderDeps = () => ({
  renderPdf: vi.fn(async () => Buffer.from("%PDF")),
  storeDocument: vi.fn(async (path: string) => `https://storage.example/${path}`),
});
const read = async (id: string) => (await db.collection("invoices").doc(id).get()).data()!;

const originalZone = process.env.TZ;

beforeEach(async () => {
  await __resetFirestoreShim();
});

afterEach(() => {
  vi.useRealTimers();
  // Node re-reads TZ when it is assigned.
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe.each(HOST_ZONES)("on a host in %s", (zone) => {
  beforeEach(() => {
    process.env.TZ = zone;
  });

  it("dates a new Invoice's due date 30 days on across the March clock change", async () => {
    const { invoiceId } = await performCreateInvoice(db, USER, { issueDate: "2026-03-15", paymentTerms: THIRTY_DAYS });
    expect(isoOf((await read(invoiceId)).dueDate)).toBe("2026-04-14T00:00:00.000Z");
  });

  it("recomputes the due date the same way when the payment terms change", async () => {
    await invoice("d", 1, "draft", "2026-03-15");
    await performUpdateInvoice(db, USER, { invoiceId: "d", patch: { paymentTerms: THIRTY_DAYS } });
    expect(isoOf((await read("d")).dueDate)).toBe("2026-04-14T00:00:00.000Z");
  });

  it("pre-numbers a New Year's Day draft in the new year's sequence", async () => {
    await invoice("old", 9, "issued", "2026-12-31");
    await invoice("new", 1, "issued", "2027-01-01");
    const { invoiceId } = await performCreateInvoice(db, USER, { issueDate: "2027-01-01" });
    expect((await read(invoiceId)).numberSeq).toBe(2);
  });

  it("issues a New Year's Day Invoice with the new year in its number", async () => {
    await invoice("d", 1, "draft", "2027-01-01");
    await performIssueInvoice(db, USER, { invoiceId: "d" }, renderDeps());
    expect((await read("d")).number).toBe("RE-2027-0001");
  });

  it("renumbers with the year of the stored issue date", async () => {
    await invoice("d", 1, "draft", "2026-12-31");
    await performUpdateInvoice(db, USER, { invoiceId: "d", patch: { issueDate: "2027-01-01" } });
    await performIssueInvoice(db, USER, { invoiceId: "d" }, renderDeps());
    expect((await read("d")).number).toBe("RE-2027-0001");
  });

  describe("at 00:30 on New Year's Day in Vienna", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NEW_YEARS_NIGHT);
    });

    it("issues a new Invoice without a stated date on the Vienna day", async () => {
      const { invoiceId } = await performCreateInvoice(db, USER, { paymentTerms: THIRTY_DAYS });
      const created = await read(invoiceId);
      expect(isoOf(created.issueDate)).toBe("2027-01-01T00:00:00.000Z");
      expect(isoOf(created.dueDate)).toBe("2027-01-31T00:00:00.000Z");
    });

    it("issues a duplicate on the Vienna day, due 30 days on", async () => {
      await invoice("src", 4, "issued", "2026-06-01");
      const { invoiceId } = await performDuplicateInvoice(db, USER, { invoiceId: "src" });
      const copy = await read(invoiceId);
      expect(isoOf(copy.issueDate)).toBe("2027-01-01T00:00:00.000Z");
      expect(isoOf(copy.dueDate)).toBe("2027-01-31T00:00:00.000Z");
    });

    it("numbers a Cancel's Invoice Correction in the new year", async () => {
      await invoice("a", 7, "issued", "2026-11-20");
      const res = await performCancelInvoice(db, USER, { invoiceId: "a" }, renderDeps());
      expect(res.correctionNumber).toBe("RE-2027-0001");
    });

    it("lets an Invoice issued today be undone", async () => {
      await invoice("a", 1, "issued", "2027-01-01");
      await performUndoIssueInvoice(db, USER, { invoiceId: "a" }, { deleteStoredDocument: vi.fn(async () => {}) });
      expect((await read("a")).status).toBe("draft");
    });
  });
});
