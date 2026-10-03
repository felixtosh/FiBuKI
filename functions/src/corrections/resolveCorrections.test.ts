/**
 * Resolving refunds to their originals (#564): stored records in, each
 * Transaction's correction out, in the shape the pure UVA calculation takes.
 */

import { describe, it, expect } from "vitest";
import { resolveCorrections, type CorrectionFileRecord, type CorrectionInvoiceRecord } from "./resolveCorrections";
import { classifyCorrectionDocument } from "./classifyCorrectionDocument";
import { calculateUva } from "../uva/calculateUva";
import { buildUvaTransactions, type TransactionRecord } from "../uva/adapter";

const day = (iso: string) => ({ toDate: () => new Date(`${iso}T00:00:00Z`) });

const tx = (id: string, date: string, amount: number, fileIds: string[]): TransactionRecord => ({
  id,
  date: day(date),
  amount,
  fileIds,
});

/** A 120,00 Amazon purchase at 20%, paid on 5 January. */
const purchaseFile = (over: Partial<CorrectionFileRecord> = {}): CorrectionFileRecord => ({
  id: "f-invoice",
  extractedAmount: 12000,
  extractedVatAmount: 2000,
  extractedVatPercent: 20,
  invoiceDirection: "incoming",
  transactionIds: ["t-purchase"],
  ...over,
});
const purchase = tx("t-purchase", "2026-01-05", -12000, ["f-invoice"]);

const creditNote = (over: Partial<CorrectionFileRecord> = {}): CorrectionFileRecord => ({
  id: "f-credit",
  extractedAmount: -3000,
  extractedVatAmount: -500,
  extractedVatPercent: 20,
  extractedSelfDesignation: "Gutschrift",
  transactionIds: ["t-refund"],
  ...over,
});
const refund = tx("t-refund", "2026-02-10", 3000, ["f-credit"]);

function resolve(
  transactions: TransactionRecord[],
  files: CorrectionFileRecord[],
  others: TransactionRecord[] = [],
  extra: { invoices?: CorrectionInvoiceRecord[]; correctionFileIdsByOriginal?: Map<string, string[]> } = {}
) {
  return resolveCorrections({
    transactions,
    filesById: new Map(files.map((f) => [f.id, f])),
    transactionsById: new Map(others.map((t) => [t.id, t])),
    invoicesById: new Map((extra.invoices ?? []).map((i) => [i.id, i])),
    correctionFileIdsByOriginal: extra.correctionFileIdsByOriginal,
  });
}

describe("resolveCorrections", () => {
  it("links a credit note to its original through the stored link, with the original's claim", () => {
    const c = resolve(
      [refund],
      [purchaseFile(), creditNote({ correctionLink: { fileId: "f-invoice", setBy: "auto" } })],
      [purchase]
    ).get("t-refund");
    expect(c).toEqual({
      status: "linked",
      kind: "purchase",
      basis: "link",
      original: {
        fileId: "f-invoice",
        paidByTransactionIds: ["t-purchase"],
        gross: 12000,
        claimed: [{ rate: 20, net: 10000, vat: 2000 }],
      },
      priorCorrected: [],
      printedVat: 500,
      correctionFileId: "f-credit",
    });
  });

  it("treats the original purchase File on the refund line as the link (D9)", () => {
    const refundWithInvoice = tx("t-refund", "2026-02-10", 3000, ["f-invoice"]);
    const c = resolve(
      [refundWithInvoice],
      [purchaseFile({ transactionIds: ["t-purchase", "t-refund"] })],
      [purchase]
    ).get("t-refund");
    expect(c).toMatchObject({ status: "linked", kind: "purchase", basis: "connected-original" });
    // The purchase itself stays a purchase.
    expect(
      resolve([purchase, refundWithInvoice], [purchaseFile({ transactionIds: ["t-purchase", "t-refund"] })]).get(
        "t-purchase"
      )
    ).toBeUndefined();
  });

  it("does not take two instalments of one File for a refund", () => {
    const second = tx("t-second", "2026-02-05", -6000, ["f-invoice"]);
    const files = [purchaseFile({ transactionIds: ["t-purchase", "t-second"] })];
    expect(resolve([second], files, [purchase]).size).toBe(0);
  });

  it("leaves a Self-billed Invoice paid out to the User as revenue", () => {
    const payout = tx("t-payout", "2026-02-10", 5000, ["f-payout"]);
    const file: CorrectionFileRecord = {
      id: "f-payout",
      extractedAmount: 5000,
      extractedSelfDesignation: "Gutschrift",
      invoiceDirection: "incoming",
      transactionIds: ["t-payout"],
    };
    expect(resolve([payout], [file]).size).toBe(0);
  });

  it("marks a credit note with no original on file as unlinked", () => {
    expect(resolve([refund], [creditNote()]).get("t-refund")).toEqual({
      status: "unlinked",
      reason: "no-link",
      fileIds: ["f-credit"],
    });
  });

  it("marks an original no Transaction on file paid as unlinked, original-unpaid", () => {
    const c = resolve(
      [refund],
      [purchaseFile({ transactionIds: [] }), creditNote({ correctionLink: { fileId: "f-invoice", setBy: "manual" } })]
    ).get("t-refund");
    expect(c).toMatchObject({ status: "unlinked", reason: "original-unpaid", originalFileId: "f-invoice" });
  });

  it("counts earlier refunds of the same original against the cap, through any of its credit notes", () => {
    const first = tx("t-first", "2026-01-20", 6000, ["f-credit-1"]);
    const files = [
      purchaseFile(),
      creditNote({ id: "f-credit-1", transactionIds: ["t-first"], correctionLink: { fileId: "f-invoice", setBy: "auto" } }),
      creditNote({ correctionLink: { fileId: "f-invoice", setBy: "auto" } }),
    ];
    const c = resolve([refund], files, [purchase, first], {
      correctionFileIdsByOriginal: new Map([["f-invoice", ["f-credit-1", "f-credit"]]]),
    }).get("t-refund");
    expect(c).toMatchObject({ priorCorrected: [{ rate: 20, net: 5000, vat: 1000 }] });
  });

  it("corrects nothing when the original claimed nothing (a 0% marketplace purchase)", () => {
    const c = resolve(
      [refund],
      [
        purchaseFile({ extractedVatAmount: 0, extractedVatPercent: 0 }),
        creditNote({ correctionLink: { fileId: "f-invoice", setBy: "auto" } }),
      ],
      [purchase]
    ).get("t-refund");
    expect(c).toMatchObject({ original: { claimed: [{ rate: 0, vat: 0 }] } });
  });

  it("links the User's refund through the Invoice Correction FiBuKI issued", () => {
    const sale = tx("t-sale", "2026-01-10", 12000, ["f-sale"]);
    const payback = tx("t-payback", "2026-02-10", -12000, ["f-correction"]);
    const files: CorrectionFileRecord[] = [
      { id: "f-sale", extractedAmount: 12000, extractedVatAmount: 2000, extractedVatPercent: 20, invoiceId: "inv-1", transactionIds: ["t-sale"] },
      { id: "f-correction", extractedAmount: -12000, extractedVatAmount: -2000, extractedVatPercent: 20, invoiceId: "inv-2", transactionIds: ["t-payback"] },
    ];
    const invoices = [
      { id: "inv-1", fileId: "f-sale" },
      { id: "inv-2", fileId: "f-correction", correctsInvoice: { invoiceId: "inv-1" } },
    ];
    expect(resolve([payback], files, [sale], { invoices }).get("t-payback")).toMatchObject({
      status: "linked",
      kind: "sale",
      basis: "issued-correction",
      original: { fileId: "f-sale", claimed: [{ rate: 20, net: 10000, vat: 2000 }] },
    });
  });

  it("feeds the period run: the adapter carries the correction to the calculation", () => {
    const files = [purchaseFile(), creditNote({ correctionLink: { fileId: "f-invoice", setBy: "auto" } })];
    const corrections = resolve([refund], files, [purchase]);
    const report = calculateUva({
      period: { year: 2026, period: 1, type: "quarterly" },
      transactions: buildUvaTransactions([refund], {
        filesById: new Map(files.map((f) => [f.id, f])),
        categoriesById: new Map(),
        correctionByTransactionId: corrections,
      }),
    });
    expect(report.kennzahlen["067"].value).toBe(-500);
    expect(report.kennzahlen["022"]).toBeUndefined();
  });
});

describe("classifyCorrectionDocument (D8)", () => {
  it("lets a referenced invoice number outrank the sign, and flags the disagreement", () => {
    expect(classifyCorrectionDocument({ extractedReferencedInvoiceNumber: "R-1", extractedAmount: 3000 })).toEqual({
      kind: "invoice-correction",
      signalsDisagree: true,
    });
  });

  it("reads a negative Gutschrift as a correction and a positive one as a Self-billed Invoice", () => {
    expect(classifyCorrectionDocument({ extractedSelfDesignation: "Gutschrift", extractedAmount: -3000 }).kind).toBe(
      "invoice-correction"
    );
    expect(classifyCorrectionDocument({ extractedSelfDesignation: "Gutschrift", extractedAmount: 3000 }).kind).toBe(
      "self-billed-invoice"
    );
  });

  it("reads negative figures with no heading as a correction a person should confirm", () => {
    expect(classifyCorrectionDocument({ extractedAmount: -3000 })).toEqual({
      kind: "invoice-correction",
      signalsDisagree: true,
    });
  });

  it("reads an ordinary invoice as neither", () => {
    expect(classifyCorrectionDocument({ extractedSelfDesignation: "Rechnung", extractedAmount: 3000 }).kind).toBeNull();
  });
});
