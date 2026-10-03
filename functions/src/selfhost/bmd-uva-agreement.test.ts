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
import { bookingSide } from "../uva/correction";
import type { UvaCorrection } from "../uva/types";

const T = (iso: string) => Timestamp.fromDate(new Date(iso));
/** Mid-March, so every fixture lands inside 2026-Q1 and 2026-03. */
const DATE = T("2026-03-15T12:00:00Z");

interface Fixture {
  name: string;
  tx: TransactionForExport;
  files?: FileForExport[];
}

/** A correction linked to a 120,00 original at 20%, which claimed (or owed) 20,00. */
function linkedCorrection(
  kind: "purchase" | "sale",
  original: { gross: number; claimed: Array<{ rate: number; net: number; vat: number }> } = {
    gross: 12000,
    claimed: [{ rate: 20, net: 10000, vat: 2000 }],
  },
): UvaCorrection {
  return {
    status: "linked",
    kind,
    basis: "link",
    original: { fileId: "f-original", paidByTransactionIds: ["t-original"], ...original },
    priorCorrected: [],
  };
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
  // #564: a correction books on its original's side, in both outputs.
  withFile("purchase refund, linked to a 20% original", 3000, {
    extractedAmount: -3000,
    extractedVatAmount: -500,
    extractedVatPercent: 20,
  }, { correction: linkedCorrection("purchase") }),
  withFile("purchase refund of a mixed 20/0 original", 4000, {
    extractedAmount: -4000,
  }, {
    correction: linkedCorrection("purchase", {
      gross: 8000,
      claimed: [{ rate: 20, net: 5000, vat: 1000 }, { rate: 0, net: 2000, vat: 0 }],
    }),
  }),
  withFile("the User's refund to a customer, linked", -6000, {
    extractedAmount: -6000,
    extractedVatAmount: -1000,
    extractedVatPercent: 20,
  }, { correction: linkedCorrection("sale") }),
  withFile("purchase refund, unlinked (defaults to 20% revenue)", 3000, {
    extractedAmount: -3000,
    extractedVatAmount: -500,
    extractedVatPercent: 20,
  }, { correction: { status: "unlinked", reason: "no-link", fileIds: ["f1"] } }),
  withFile("own refund, unlinked (claims nothing)", -3000, {
    extractedAmount: -3000,
    extractedVatAmount: -500,
    extractedVatPercent: 20,
  }, { correction: { status: "unlinked", reason: "no-link", fileIds: ["f1"] } }),
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
      saleSupplyKind: f.tx.saleSupplyKind ?? null,
      noReceiptCategoryId: f.tx.noReceiptCategoryId ?? null,
      noReceiptCategoryTemplateId: f.tx.noReceiptCategoryTemplateId ?? null,
      fileIds: f.tx.fileIds,
      partialPaymentAcceptance: f.tx.partialPaymentAcceptance ?? null,
    },
    {
      filesById,
      categoriesById,
      correctionByTransactionId: f.tx.correction ? new Map([[f.tx.id, f.tx.correction]]) : undefined,
    },
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
  // A correction's VAT is a reduction on its original's side (#564); the
  // export carries it unsigned under the flipped bucod, so compare magnitudes.
  const side = bookingSide(f.tx);
  if (side === "purchase-correction") return -report.totalInputVat;
  if (side === "sale-correction") return -report.totalOutputVat;
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

/**
 * A tip the bank line does not cover (#554). Both sides used to let it
 * through: the UVA as a partial payment it scaled and returned `ok`, the
 * export by booking `bank - tip` at the document's rates and the whole tip at
 * 0%, and the two disagreed about the VAT. Now both stop on the same
 * predicate, and both let it through once an Accepted Partial Payment is live.
 */
describe("bmd/uva agreement (#554): a tip the bank line does not cover", () => {
  /** 100,00 at 20%, 16,67 of VAT, with a tip beside it. */
  const hundred = (name: string, bank: number, tip: number, txOver: Partial<TransactionForExport> = {}) =>
    withFile(
      name,
      bank,
      {
        extractedAmount: 10000,
        extractedTipAmount: tip,
        extractedVatAmount: 1667,
        extractedVatPercent: 20,
      },
      txOver,
    );
  /** A 3,00 coffee at 10%. */
  const coffee = (name: string, bank: number, tip: number) =>
    withFile(name, bank, {
      extractedAmount: 300,
      extractedTipAmount: tip,
      extractedVatAmount: 27,
      extractedVatPercent: 10,
    });

  /** The ruling a person makes over the split bill as it stands. */
  const splitRuling = (tip = 1000) => ({
    by: "user-1",
    at: null,
    reason: "Split the bill, paid my half",
    bankAmount: -5500,
    files: [{ id: "f1", total: 10000, tip }],
  });

  const exportOf = (f: Fixture) =>
    generateBuchungenCsvWithReport(
      [f.tx],
      new Map((f.files ?? []).map((file) => [file.id, file])),
      new Map(),
    );

  /** The booking rows, as `{ gross, vat, rate }` in cents/percent. */
  const rowsOf = (csv: string) =>
    csv
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const cols = line.split(";");
        return {
          gross: Math.round(Number(cols[6].replace(",", ".")) * 100),
          vat: Math.round(Number(cols[8].replace(",", ".")) * 100),
          rate: Number(cols[9]),
        };
      });

  const refused = [
    hundred("mistyped tip: 100,00 typed for 10,00, paid 110,00", -11000, 10000),
    coffee("3,00 + 7,99 paid with 8,00", -800, 799),
    hundred("split bill without a ruling", -5500, 1000),
    hundred("split bill whose ruling went stale: the tip changed", -5500, 1200, {
      partialPaymentAcceptance: splitRuling(1000),
    }),
    hundred("split bill whose ruling went stale: the bank amount changed", -5600, 1000, {
      partialPaymentAcceptance: splitRuling(1000),
    }),
  ];

  for (const f of refused) {
    it(`is refused by both: ${f.name}`, () => {
      const { csv, skipped } = exportOf(f);
      const report = uvaReportFor(f);

      expect(rowsOf(csv)).toEqual([]);
      expect(skipped.map((s) => s.fileId)).toEqual(["f1"]);
      expect(skipped[0].reason).toMatch(/short of document total plus tip/);

      expect(report.totalInputVat).toBe(0);
      expect(report.unresolved.map((u) => u.reason)).toEqual(["tip-partial-payment"]);
    });
  }

  it("names the figures it compared in the refusal", () => {
    const { skipped } = exportOf(refused[0]);

    expect(skipped[0].reason).toBe(
      "bank amount (110,00) is short of document total plus tip (200,00, tip 100,00); " +
        "correct the tip, or record an Accepted Partial Payment if only part of the bill " +
        "was paid, and re-run",
    );
  });

  it("books 3,00 + 5,00 against 8,00 in full on both sides, unchanged", () => {
    const f = coffee("3,00 + 5,00 paid with 8,00", -800, 500);
    const { csv, skipped } = exportOf(f);
    const report = uvaReportFor(f);

    expect(skipped).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.totalInputVat).toBe(27);
    expect(rowsOf(csv)).toEqual([
      { gross: 300, vat: 27, rate: 10 },
      { gross: 500, vat: 0, rate: 0 },
    ]);
    expect(exportVatCents(f)).toBe(reportVatCents(f));
  });

  it("books a ruled split bill at half on both sides, tip row included", () => {
    const f = hundred("split bill with a live ruling", -5500, 1000, {
      partialPaymentAcceptance: splitRuling(),
    });
    const { csv, skipped } = exportOf(f);
    const report = uvaReportFor(f);

    expect(skipped).toEqual([]);
    expect(report.unresolved).toEqual([]);
    // Half of 16,67, on the instalment anchor: 8,335 rounds to 8,34.
    expect(report.totalInputVat).toBe(834);
    // 50,00 at 20% and 5,00 at 0%: the tip row is scaled with the payment.
    // Before #554 the export booked 45,00 at 20% and the whole 10,00 at 0%.
    expect(rowsOf(csv)).toEqual([
      { gross: 5000, vat: 833, rate: 20 },
      { gross: 500, vat: 0, rate: 0 },
    ]);
    // The export recomputes VAT from the gross it books (50,00 at 20% is
    // 8,333), the UVA scales the document's printed 16,67. That is the
    // rounding of every partial payment, not a disagreement about the base.
    expect(Math.abs(exportVatCents(f) - reportVatCents(f))).toBeLessThanOrEqual(1);
  });
});

/**
 * The side, not just the tax (#564). Equal VAT totals would still pass with a
 * refund booked to a Debitor as a sale, which is the bug: the account and the
 * direction have to agree with the UVA's side too.
 */
describe("bmd/uva agreement on the booking side (#564)", () => {
  const rowFields = (f: Fixture) => {
    const files = new Map((f.files ?? []).map((file) => [file.id, file]));
    return generateBuchungenCsv([f.tx], files, new Map(), 1)
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const c = line.split(";");
        return { konto: c[1], gkto: c[2], betrag: c[6], bucod: c[7], steuer: c[8], mwst: c[9], symbol: c[12] };
      });
  };
  const byName = (name: string) => FIXTURES.find((f) => f.name === name)!;

  it("books a purchase refund on the Kreditor, opposite to the purchase, as ER", () => {
    expect(rowFields(byName("purchase refund, linked to a 20% original"))).toEqual([
      { konto: "200001", gkto: "7000", betrag: "30,00", bucod: "2", steuer: "5,00", mwst: "20", symbol: "ER" },
    ]);
  });

  it("books the part of a refund the original claimed nothing on as a 0% row", () => {
    expect(rowFields(byName("purchase refund of a mixed 20/0 original"))).toEqual([
      { konto: "200001", gkto: "7000", betrag: "30,00", bucod: "2", steuer: "5,00", mwst: "20", symbol: "ER" },
      { konto: "200001", gkto: "7000", betrag: "10,00", bucod: "2", steuer: "0,00", mwst: "0", symbol: "ER" },
    ]);
  });

  it("books the User's refund on the Debitor, opposite to the sale, as AR", () => {
    expect(rowFields(byName("the User's refund to a customer, linked"))).toEqual([
      { konto: "300001", gkto: "4000", betrag: "60,00", bucod: "1", steuer: "10,00", mwst: "20", symbol: "AR" },
    ]);
  });

  it("books an unlinked refund as the preview does: a sale at 20% on the Debitor", () => {
    expect(rowFields(byName("purchase refund, unlinked (defaults to 20% revenue)"))).toEqual([
      { konto: "300001", gkto: "4000", betrag: "30,00", bucod: "2", steuer: "5,00", mwst: "20", symbol: "AR" },
    ]);
  });
});

describe("bmd/uva agreement (#565): a service supplied abroad", () => {
  // An outgoing invoice at 0% to an EU business, and one to a UK customer the
  // person classified by hand. Neither carries Austrian VAT on either side.
  const SERVICES: Fixture[] = [
    withFile("EU service, detected from the document", 50000, {
      extractedAmount: 50000,
      extractedVatAmount: 0,
      extractedVatPercent: 0,
      matchedUserAccount: "issuer",
      extractedRecipient: { vatId: "DE123456789", country: "DE" },
    }, { partnerName: "Kunde GmbH" }),
    withFile("non-EU service, classified by hand", 189000, {
      extractedAmount: 189000,
      extractedVatAmount: 0,
      extractedVatPercent: 0,
    }, { partnerName: "Thames Consulting Ltd", saleSupplyKind: "service-non-eu", vatId: "GB123456789" }),
  ];

  const rowsOf = (f: Fixture) => {
    const files = new Map((f.files ?? []).map((file) => [file.id, file]));
    return generateBuchungenCsv([f.tx], files, new Map()).split("\n").slice(1).filter(Boolean)
      .map((line) => line.split(";"));
  };

  for (const f of SERVICES) {
    it(`states 0 VAT on both sides, and keeps it off every Kennzahl: ${f.name}`, () => {
      expect(exportVatCents(f)).toBe(0);
      expect(reportVatCents(f)).toBe(0);
      const report = uvaReportFor(f);
      expect(report.kennzahlen["000"]).toBeUndefined();
      expect(report.kennzahlen["011"]).toBeUndefined();
    });
  }

  it("books the row at mwst 0 with the customer's UID and a note naming the kind", () => {
    const [eu] = rowsOf(SERVICES[0]);
    // headers: ... betrag(6) bucod(7) steuer(8) mwst(9) text(10) ... uidnr(13)
    expect(eu[8]).toBe("0,00");
    expect(eu[9]).toBe("0");
    expect(eu[10]).toBe("§3a Abs6 EU: Kunde GmbH");
    expect(eu[13]).toBe("DE123456789");

    const [uk] = rowsOf(SERVICES[1]);
    expect(uk[10]).toBe("§3a Abs6 Drittland: Thames Consulting Ltd");
    expect(uk[13]).toBe("GB123456789");
  });

  it("leaves an export of goods' row as it was", () => {
    const goods = withFile("export of goods", 50000, {
      extractedAmount: 50000,
      extractedVatAmount: 0,
      extractedVatPercent: 0,
    }, { partnerName: "Buyer Ltd", saleSupplyKind: "export-goods" });
    const [row] = rowsOf(goods);
    expect(row[10]).toBe("Buyer Ltd");
    expect(uvaReportFor(goods).kennzahlen["011"]?.value).toBe(50000);
  });
});
