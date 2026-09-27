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
  generateBuchungenCsvWithReport,
  type FileForExport,
  type TransactionForExport,
} from "../bmd-export/bmdCsvGenerators";
import { calculateUva } from "../uva/calculateUva";
import { buildUvaTransaction, type CategoryRecord, type FileRecord } from "../uva/adapter";
import { buildEcbRateTable, type EcbRateTable } from "../fx/ecbRates";

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
  // #172: Summe 50,80 (10% + 20%), Trinkgeld 3,20, Gesamt 54,00. The export
  // books the whole 54,00 and the tip must carry no tax on either side.
  withFile("printed Trinkgeld on a restaurant Beleg", -5400, {
    extractedAmount: 5080,
    extractedTipAmount: 320,
    extractedRateGroups: [
      { rate: 10, net: 3500, vat: 350, gross: 3850 },
      { rate: 20, net: 1025, vat: 205, gross: 1230 },
    ],
  }),
  // #317: the Gesamt (54,00) transcribed into the Trinkgeld field of a 54,00
  // charge. The export refuses the transaction (#194); the UVA used to read
  // 108,00 as the invoice total, call the bank line a half payment and claim
  // 2,86. Both now state nothing.
  withFile("impossible Trinkgeld, tip EQUALS the bank amount", -5400, {
    extractedAmount: 5080,
    extractedTipAmount: 5400,
    extractedRateGroups: [
      { rate: 10, net: 3500, vat: 350, gross: 3850 },
      { rate: 20, net: 1025, vat: 205, gross: 1230 },
    ],
  }),
  withFile("impossible Trinkgeld, tip EXCEEDS the bank amount", -2000, {
    extractedAmount: 5080,
    extractedTipAmount: 5400,
    extractedRateGroups: [
      { rate: 10, net: 3500, vat: 350, gross: 3850 },
      { rate: 20, net: 1025, vat: 205, gross: 1230 },
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
function exportVatCents(f: Fixture, ecbRates: EcbRateTable | null = null): number {
  const files = new Map((f.files ?? []).map((file) => [file.id, file]));
  const lines = generateBuchungenCsv([f.tx], files, new Map(), 1, ecbRates).split("\n").slice(1);
  return lines
    .filter(Boolean)
    .reduce((sum, line) => sum + Math.round(Number(line.split(";")[8].replace(",", ".")) * 100), 0);
}

/** The UVA report for one fixture, run over the period it lands in. */
function uvaReportFor(f: Fixture, ecbRates: EcbRateTable | null = null) {
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
  return calculateUva({
    period: { year: 2026, period: 3, type: "monthly" },
    transactions: [uvaTx],
    ecbRates,
  });
}

/** The same transaction's VAT as the UVA report states it, in cents. */
function reportVatCents(f: Fixture, ecbRates: EcbRateTable | null = null): number {
  const report = uvaReportFor(f, ecbRates);
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

/**
 * Equal totals are not enough for the impossible tip (#317): two zeroes agree
 * by accident as easily as by construction. What the ticket is about is that
 * the two sides REFUSE the same transaction, and say so — the export by
 * withholding it and naming the document, the UVA by putting it on the review
 * list as `impossible-tip` rather than scaling it as a partial payment.
 */
describe("bmd/uva agreement (#317): an impossible Trinkgeld", () => {
  const impossible = FIXTURES.filter((f) => f.name.startsWith("impossible Trinkgeld"));

  it("has fixtures on both sides of the boundary", () => {
    expect(impossible.map((f) => f.tx.amount)).toEqual([-5400, -2000]);
  });

  for (const f of impossible) {
    it(`is refused by both, not scaled: ${f.name}`, () => {
      const files = new Map((f.files ?? []).map((file) => [file.id, file]));
      const { csv, skipped } = generateBuchungenCsvWithReport([f.tx], files, new Map());
      const report = uvaReportFor(f);

      // The export: no booking rows at all, and the document named.
      expect(csv.split("\n").filter(Boolean)).toHaveLength(1);
      expect(skipped.map((s) => s.fileId)).toEqual(["f1"]);

      // The UVA: nothing claimed, and the reason names the tip. Before #317
      // this was the partial-payment branch — 2,86 of Vorsteuer on the 54,00
      // fixture, from a bank/invoiceTotal fraction of 0,5.
      expect(report.totalInputVat).toBe(0);
      expect(report.unresolved.map((u) => u.reason)).toEqual(["impossible-tip"]);
      expect(exportVatCents(f)).toBe(reportVatCents(f));
    });
  }
});

/**
 * A foreign-currency Trinkgeld is judged in euros on both sides (#326).
 *
 * The UVA converts a foreign document before it reads a figure off it; the
 * export used to hand `assessTip` the document as extracted, so it compared
 * koruny or pounds against the euro bank line and could reach the opposite
 * verdict. Both sides now read the same converted documents at the same rate,
 * so the fixtures run with the rate table the UVA run loads.
 */
describe("bmd/uva agreement (#326): a foreign-currency Trinkgeld", () => {
  /** 25 CZK and 0,80 GBP per euro, published the Friday before DATE. */
  const ECB = buildEcbRateTable([{ date: "2026-03-13", rates: { CZK: 25, GBP: 0.8 } }]);

  // 1.000,00 CZK at 20% and a 50,00 CZK tip on top, paid with 42,00 EUR:
  // (1.000 + 50) / 25. Read as-is the tip, 50,00, is not less than the 42,00
  // bank line and the export refused it, while the UVA converted it to 2,00
  // and claimed the document's VAT.
  const czkBooked = withFile("CZK tip, 2,00 converted, below the bank amount", -4200, {
    extractedAmount: 100000,
    extractedTipAmount: 5000,
    extractedCurrency: "CZK",
    extractedVatAmount: 16667,
    extractedVatPercent: 20,
  });

  // 30,00 GBP at 20% and a 32,00 GBP tip, paid with 36,00 EUR. The tip is
  // 40,00 in euros, not less than the bank line: both refuse. Read as-is it is
  // 32,00, and the export's refusal said "32,00 is not less than 36,00".
  const gbpRefused = withFile("GBP tip, 40,00 converted, above the bank amount", -3600, {
    extractedAmount: 3000,
    extractedTipAmount: 3200,
    extractedCurrency: "GBP",
    extractedVatAmount: 500,
    extractedVatPercent: 20,
  });

  const exportOf = (f: Fixture) =>
    generateBuchungenCsvWithReport(
      [f.tx],
      new Map((f.files ?? []).map((file) => [file.id, file])),
      new Map(),
      1,
      ECB,
    );

  it("books a converted tip below the bank amount on both sides, with the same VAT", () => {
    const { skipped } = exportOf(czkBooked);
    const report = uvaReportFor(czkBooked, ECB);

    expect(skipped).toEqual([]);
    expect(report.unresolved).toEqual([]);
    // 1.000,00 CZK at 0,04 is 40,00 EUR, 6,67 of it VAT. The export books
    // 42,00 − 2,00 across the document's rate and the 2,00 tip at 0%.
    expect(report.totalInputVat).toBe(667);
    expect(exportVatCents(czkBooked, ECB)).toBe(reportVatCents(czkBooked, ECB));
  });

  it("refuses a converted tip not below the bank amount on both sides", () => {
    const { csv, skipped } = exportOf(gbpRefused);
    const report = uvaReportFor(gbpRefused, ECB);

    expect(csv.split("\n").filter(Boolean)).toHaveLength(1);
    expect(skipped.map((s) => s.fileId)).toEqual(["f1"]);
    expect(report.totalInputVat).toBe(0);
    expect(report.unresolved.map((u) => u.reason)).toEqual(["impossible-tip"]);
  });

  it("states the tip it compared, the converted one, in the refusal", () => {
    const { skipped } = exportOf(gbpRefused);

    expect(skipped[0].reason).toBe(
      "tip (40,00, converted from 32,00 GBP) is not less than the bank amount (36,00); " +
        "correct the tip on this document and re-run",
    );
  });
});
