/**
 * The BMD export and the UVA report must state the same VAT (fork #66).
 *
 * This is the regression guard for the divergence the issue was filed about:
 * the export used to answer "what VAT does this line carry" with
 * `tx.vatRate ?? 20` while the UVA read the actual receipts, so a BMD/DATEV
 * trail and a filed UVA could disagree about the same transaction and nothing
 * would notice.
 *
 * Both sides now run the same derivation ladder. This test runs BOTH end
 * surfaces over one fixture set and asserts the totals agree, so a future
 * change to either one that reintroduces a private VAT rule fails here.
 *
 * The comparison is on totals rather than per-row, because the two disagree on
 * SHAPE by design: the export books the whole payment (a partial payment is
 * still money that moved), while the UVA claims only the documented fraction.
 * Where they must agree is the tax.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "./firestore-shim";
import {
  generateBuchungenCsv,
  type FileForExport,
  type TransactionForExport,
} from "../bmd-export/bmdCsvGenerators";
import { calculateUva } from "../uva/calculateUva";
import { buildUvaTransaction, type CategoryRecord, type FileRecord } from "../uva/adapter";

const T = (iso: string) => Timestamp.fromDate(new Date(iso));
/** Mid-March, so every fixture lands inside 2026-Q1 and 2026-03. */
const DATE = T("2026-03-15T12:00:00Z");

interface Fixture {
  name: string;
  tx: TransactionForExport;
  files?: FileForExport[];
}

const withFile = (
  name: string,
  amount: number,
  file: Partial<FileForExport>,
  txOver: Partial<TransactionForExport> = {},
): Fixture => ({
  name,
  tx: { id: "t", date: DATE, amount, fileIds: ["f1"], ...txOver },
  files: [{ id: "f1", fileName: "beleg.pdf", ...file }],
});

const FIXTURES: Fixture[] = [
  withFile("top-level 20%", -12000, {
    extractedAmount: 12000,
    extractedVatAmount: 2000,
    extractedVatPercent: 20,
  }),
  withFile("top-level 10%", -11000, {
    extractedAmount: 11000,
    extractedVatAmount: 1000,
    extractedVatPercent: 10,
  }),
  withFile("printed rate groups, two rates", -3300, {
    extractedAmount: 3300,
    extractedRateGroups: [
      { rate: 20, net: 1000, vat: 200, gross: 1200 },
      { rate: 10, net: 1909, vat: 191, gross: 2100 },
    ],
  }),
  withFile("line items, two rates", -3300, {
    extractedAmount: 3300,
    extractedLineItems: [
      { description: "book", vatPercent: 10, vatAmount: 191, amount: 2100 },
      { description: "pen", vatPercent: 20, vatAmount: 200, amount: 1200 },
    ],
  }),
  withFile("partial payment, half the invoice", -6000, {
    extractedAmount: 12000,
    extractedVatAmount: 2000,
    extractedVatPercent: 20,
  }),
  withFile("unreconciled line items", -12000, {
    extractedAmount: 12000,
    extractedVatAmount: 2000,
    extractedVatPercent: 20,
    lineItemsUnreconciled: true,
  }),
  withFile("reverse charge", -10000, { extractedAmount: 10000, extractedVatId: "IE6388047V" }, {
    isReverseCharge: true,
  }),
  {
    name: "manual rate override, no document",
    tx: { id: "t", date: DATE, amount: -11000, vatRate: 10 },
  },
  {
    name: "undocumented expense",
    tx: { id: "t", date: DATE, amount: -999 },
  },
  {
    name: "undocumented income (defaults to 20%)",
    tx: { id: "t", date: DATE, amount: 250000 },
  },
  {
    name: "exempt category (bank fees)",
    tx: {
      id: "t",
      date: DATE,
      amount: -500,
      noReceiptCategoryId: "c1",
      noReceiptCategoryTemplateId: "bank-fees",
    },
  },
  {
    name: "Eigenbeleg (receipt-lost)",
    tx: {
      id: "t",
      date: DATE,
      amount: -6000,
      noReceiptCategoryId: "c1",
      noReceiptCategoryTemplateId: "receipt-lost",
    },
  },
];

/** Sum the `steuer` column of the export, in cents. */
function exportVatCents(f: Fixture): number {
  const files = new Map((f.files ?? []).map((file) => [file.id, file]));
  const lines = generateBuchungenCsv([f.tx], files, new Map()).split("\n").slice(1);
  return lines
    .filter(Boolean)
    .reduce((sum, line) => sum + Math.round(Number(line.split(";")[8].replace(",", ".")) * 100), 0);
}

/** The same transaction's VAT as the UVA report states it, in cents. */
function reportVatCents(f: Fixture): number {
  const filesById = new Map<string, FileRecord>(
    (f.files ?? []).map((file) => [file.id, file as FileRecord]),
  );
  const categoriesById = new Map<string, CategoryRecord>();
  if (f.tx.noReceiptCategoryId) {
    categoriesById.set(f.tx.noReceiptCategoryId, {
      id: f.tx.noReceiptCategoryId,
      templateId: f.tx.noReceiptCategoryTemplateId ?? null,
    });
  }
  const uvaTx = buildUvaTransaction(
    {
      id: f.tx.id,
      date: f.tx.date,
      amount: f.tx.amount,
      currency: f.tx.currency ?? null,
      partner: f.tx.partnerName ?? f.tx.partner ?? null,
      vatRate: f.tx.vatRate ?? null,
      isReverseCharge: f.tx.isReverseCharge ?? null,
      noReceiptCategoryId: f.tx.noReceiptCategoryId ?? null,
      noReceiptCategoryTemplateId: f.tx.noReceiptCategoryTemplateId ?? null,
      fileIds: f.tx.fileIds,
    },
    { filesById, categoriesById },
  );
  const report = calculateUva({
    period: { year: 2026, period: 3, type: "monthly" },
    transactions: [uvaTx],
  });
  // Reverse charge nets to zero on this line (owed and deducted in the same
  // breath), and the booking row likewise carries no tax — so comparing the
  // net figure is the right comparison for it too.
  return f.tx.amount > 0
    ? report.totalOutputVat
    : report.totalInputVat - (report.reverseCharge.length ? report.totalOutputVat : 0);
}

describe("bmd/uva agreement (#66)", () => {
  for (const f of FIXTURES) {
    it(`states the same VAT for: ${f.name}`, () => {
      expect(exportVatCents(f)).toBe(reportVatCents(f));
    });
  }

  it("the fixture set actually exercises non-zero VAT, or it proves nothing", () => {
    const nonZero = FIXTURES.filter((f) => exportVatCents(f) !== 0);
    expect(nonZero.length).toBeGreaterThanOrEqual(6);
  });
});
