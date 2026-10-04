/**
 * A Receipt and the invoice it pays count once (#571, ADR-0012).
 *
 * One table of pair cases through both amount readers: the summary of a
 * Transaction's connected Files (Coverage, the Remainder, the scorers) and the
 * UVA adapter plus calculation (the UVA and the BMD Export). Each row says
 * what the line documents and what Vorsteuer it claims, and checks that both
 * readers count the same documents.
 */

import { describe, it, expect } from "vitest";
import { filePaymentTotal, summarizeConnectedFiles } from "../coverage";
import { buildUvaTransaction, type FileRecord } from "../../uva/adapter";
import { calculateUva } from "../../uva/calculateUva";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

/** A 120,00 invoice at 20 %. */
const invoice = (over: Partial<FileRecord> = {}): FileRecord => ({
  id: "f-invoice",
  extractedAmount: 12000,
  extractedCurrency: "EUR",
  extractedRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
  ...over,
});

/** A Receipt for it; `receiptLink` names the invoice it pays. */
const receipt = (over: Partial<FileRecord> = {}): FileRecord => ({
  id: "f-receipt",
  extractedAmount: 12000,
  extractedCurrency: "EUR",
  receiptLink: { fileId: "f-invoice" },
  ...over,
});

/** The #172 restaurant Rechnung: Summe 50,80 over two rates, no tip printed. */
const rechnung: FileRecord = {
  id: "f-invoice",
  extractedAmount: 5080,
  extractedCurrency: "EUR",
  extractedRateGroups: [
    { rate: 10, net: 3500, vat: 350, gross: 3850 },
    { rate: 20, net: 1025, vat: 205, gross: 1230 },
  ],
};

interface Row {
  name: string;
  bank: number;
  files: FileRecord[];
  /** What Coverage reads the Files as documenting, in document currency. */
  documented: number;
  inputVat: number;
  unresolved?: string;
  /** Which Files the UVA reads as documents. */
  uvaFiles: string[];
}

const ROWS: Row[] = [
  {
    name: "invoice and Receipt of equal totals",
    bank: -12000,
    files: [invoice(), receipt({ extractedRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }] })],
    documented: 12000,
    inputVat: 2000,
    uvaFiles: ["f-invoice"],
  },
  {
    name: "a Receipt with a tip the invoice lacks",
    bank: -5500,
    files: [rechnung, receipt({ extractedAmount: 5500 })],
    documented: 5500,
    inputVat: 555,
    uvaFiles: ["f-invoice"],
  },
  {
    name: "a Receipt smaller than the invoice: the instalment fraction",
    bank: -6000,
    files: [invoice(), receipt({ extractedAmount: 6000 })],
    documented: 12000,
    inputVat: 1000,
    uvaFiles: ["f-invoice"],
  },
  {
    name: "two Receipts for one invoice: the largest counts, never their sum",
    bank: -12500,
    files: [invoice(), receipt(), receipt({ id: "f-slip", extractedAmount: 12500 })],
    documented: 12500,
    inputVat: 2000,
    uvaFiles: ["f-invoice"],
  },
  {
    name: "a Receipt in another currency: the invoice alone",
    bank: -12000,
    files: [invoice(), receipt({ extractedAmount: 13000, extractedCurrency: "USD" })],
    documented: 12000,
    inputVat: 2000,
    uvaFiles: ["f-invoice"],
  },
  {
    name: "a Receipt without its invoice on the line: an ordinary File",
    bank: -12000,
    files: [receipt({ receiptLink: { fileId: "f-elsewhere" }, extractedRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }] })],
    documented: 12000,
    inputVat: 2000,
    uvaFiles: ["f-receipt"],
  },
  {
    name: "a Receipt linked to an invoice on another Transaction: an ordinary File",
    bank: -12000,
    files: [
      invoice({ id: "f-other", extractedAmount: 5000, extractedRateGroups: [{ rate: 20, net: 4167, vat: 833, gross: 5000 }] }),
      receipt({ extractedAmount: 7000, receiptLink: { fileId: "f-invoice" } }),
    ],
    documented: 12000,
    inputVat: 833,
    uvaFiles: ["f-other", "f-receipt"],
  },
  {
    name: "a surplus as large as the bank line: the impossible-tip guard",
    bank: -5400,
    files: [rechnung, receipt({ extractedAmount: 10480 })],
    documented: 10480,
    inputVat: 0,
    unresolved: "impossible-tip",
    uvaFiles: ["f-invoice"],
  },
  {
    name: "a foreign-currency invoice with its Receipt: converted as one File",
    bank: -3132,
    files: [
      invoice({ extractedAmount: 3600, extractedCurrency: "USD", extractedRateGroups: null, extractedVatAmount: 600, extractedVatPercent: 20 }),
      receipt({ extractedAmount: 3600, extractedCurrency: "USD" }),
    ],
    documented: 3600,
    inputVat: 522,
    uvaFiles: ["f-invoice"],
  },
  {
    name: "a Sammelbuchung of an unlinked Receipt and invoice: both count, unchanged",
    bank: -12000,
    files: [
      invoice({ extractedAmount: 7000, extractedRateGroups: [{ rate: 20, net: 5833, vat: 1167, gross: 7000 }] }),
      receipt({ extractedAmount: 5000, receiptLink: null }),
    ],
    documented: 12000,
    inputVat: 1167,
    uvaFiles: ["f-invoice", "f-receipt"],
  },
];

function coverageReading(files: FileRecord[]): number {
  // The fields the server-side loader reads off each connected File.
  return summarizeConnectedFiles(
    files.map((f) => ({
      payment: filePaymentTotal(f.extractedAmount, f.extractedTipAmount),
      extractionPending: false,
      fileId: f.id,
      currency: f.extractedCurrency ?? null,
      receiptOfFileId: f.receiptLink?.fileId ?? null,
    }))
  ).documentedAmount;
}

function uvaReading(row: Row) {
  const uvaTx = buildUvaTransaction(
    { id: "t", date: ts("2026-02-10T00:00:00Z"), amount: row.bank, currency: "EUR", fileIds: row.files.map((f) => f.id) },
    { filesById: new Map(row.files.map((f) => [f.id, f])), categoriesById: new Map() }
  );
  const result = calculateUva({ period: { year: 2026, period: 1, type: "quarterly" }, transactions: [uvaTx] });
  return { uvaTx, result };
}

describe("a Receipt and the invoice it pays count once, in Coverage and in the UVA (#571)", () => {
  it.each(ROWS)("$name", (row) => {
    const documented = coverageReading(row.files);
    const { uvaTx, result } = uvaReading(row);

    expect(documented).toBe(row.documented);
    expect(result.totalInputVat).toBe(row.inputVat);
    if (row.unresolved) expect(result.unresolved.map((u) => u.reason)).toEqual([row.unresolved]);
    else expect(result.unresolved).toEqual([]);

    // Both readers count the same documents, to the same payment total.
    expect(uvaTx.files?.map((f) => f.id)).toEqual(row.uvaFiles);
    const uvaPayment = (uvaTx.files ?? []).reduce(
      (sum, f) => sum + Math.abs(f.totalGross ?? 0) + Math.max(f.tipAmount ?? 0, 0),
      0
    );
    expect(uvaPayment).toBe(documented);
  });

  it("books a Receipt's surplus as Trinkgeld: no VAT on the tip", () => {
    const { uvaTx } = uvaReading(ROWS[1]);
    expect(uvaTx.files?.[0]).toMatchObject({ id: "f-invoice", totalGross: 5080, tipAmount: 420 });
  });
});
