/**
 * BMD NTCS CSV generation helpers.
 * Generates semicolon-separated CSV content in BMD-compatible format.
 */

import { Timestamp } from "firebase-admin/firestore";
import {
  BmdBuchungRow,
  BmdPersonenkontoRow,
  BmdSkippedDocument,
  KREDITOR_ACCOUNT_BASE,
  DEBITOR_ACCOUNT_BASE,
} from "../types/bmd-export";
import { buildUvaTransaction, type CategoryRecord, type FileRecord } from "../uva/adapter";
import { deriveTransactionVat } from "../uva/transactionVat";
import { assessTip } from "../uva/tip";
import type { RateGroup } from "../uva/types";

/**
 * Maps no-receipt category templateIds to BMD Sachkonten.
 * expense/income = null means the category doesn't apply for that direction.
 */
export const NO_RECEIPT_SACHKONTO_MAP: Record<string, { expense: string | null; income: string | null; symbol: string; name: string }> = {
  "bank-fees":                    { expense: "7780", income: null,   symbol: "BK", name: "Bankspesen" },
  "interest":                     { expense: "7810", income: "8100", symbol: "BK", name: "Zinsen" },
  "internal-transfers":           { expense: "2800", income: "2800", symbol: "UM", name: "Umbuchung" },
  "payment-provider-settlements": { expense: "7780", income: null,   symbol: "BK", name: "PSP-Spesen" },
  "taxes-government":             { expense: "3520", income: null,   symbol: "BK", name: "Steuern/Abgaben" },
  "payroll":                      { expense: "6200", income: null,   symbol: "GH", name: "Gehalt" },
  "private-personal":             { expense: "9600", income: "9600", symbol: "PR", name: "Privat" },
  "zero-value":                   { expense: null,   income: null,   symbol: "",   name: "" },
  "receipt-lost":                 { expense: "7000", income: "4000", symbol: "ER", name: "Eigenbeleg" },
};

/**
 * Format date as YYYYMMDD for BMD
 */
export function formatBmdDate(date: Timestamp | Date | undefined): string {
  if (!date) return "";
  const d = date instanceof Timestamp ? date.toDate() : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * Format amount for BMD (positive decimal with comma as separator)
 * Amount is stored in cents, convert to euros with 2 decimal places
 */
export function formatBmdAmount(amountInCents: number | undefined): string {
  if (amountInCents === undefined || amountInCents === null) return "0,00";
  const absAmount = Math.abs(amountInCents) / 100;
  return absAmount.toFixed(2).replace(".", ",");
}

/**
 * Escape a value for BMD CSV (uses semicolon separator)
 */
export function escapeBmdCsv(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return "";
  const str = String(value);
  // Escape quotes and wrap if contains semicolon, quote, or newline
  if (str.includes(";") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Create a matchcode from partner name (uppercase alphanumeric, max 20 chars)
 */
export function createMatchcode(name: string | undefined): string {
  if (!name) return "";
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .substring(0, 20);
}

/**
 * Partner account number index - tracks assigned account numbers
 */
export type PartnerAccountIndex = Map<string, number>;

/**
 * Generate a Personenkonto number for a partner
 * Kreditoren (suppliers): 2xxxxx
 * Debitoren (customers): 3xxxxx
 */
export function generatePersonenkontoNumber(
  partnerId: string,
  isKreditor: boolean,
  partnerIndex: PartnerAccountIndex
): string {
  let index = partnerIndex.get(partnerId);
  if (index === undefined) {
    index = partnerIndex.size + 1;
    partnerIndex.set(partnerId, index);
  }

  const base = isKreditor ? KREDITOR_ACCOUNT_BASE : DEBITOR_ACCOUNT_BASE;
  return String(base + index);
}

/**
 * Partner data for export
 */
export interface PartnerForExport {
  id: string;
  name?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  vatId?: string;
  ibans?: string[];
  email?: string;
  phone?: string;
  isKreditor: boolean;
}

/**
 * Generate Personenkonten CSV content
 */
export function generatePersonenkontenCsv(
  partners: PartnerForExport[],
  partnerIndex: PartnerAccountIndex
): string {
  const headers = [
    "konto",
    "name",
    "strasse",
    "plz",
    "ort",
    "land",
    "uidnr",
    "telefon",
    "email",
    "iban",
    "matchcode",
  ];

  const rows = partners.map((partner) => {
    const row: BmdPersonenkontoRow = {
      konto: generatePersonenkontoNumber(
        partner.id,
        partner.isKreditor,
        partnerIndex
      ),
      name: (partner.name || "").substring(0, 50),
      strasse: (partner.street || "").substring(0, 50),
      plz: (partner.postalCode || "").substring(0, 10),
      ort: (partner.city || "").substring(0, 50),
      land: (partner.country || "AT").substring(0, 2).toUpperCase(),
      uidnr: (partner.vatId || "").substring(0, 20),
      telefon: (partner.phone || "").substring(0, 30),
      email: (partner.email || "").substring(0, 80),
      iban: (partner.ibans?.[0] || "").substring(0, 34),
      matchcode: createMatchcode(partner.name),
    };
    return row;
  });

  const csvRows = rows.map((row) =>
    headers
      .map((h) => escapeBmdCsv(row[h as keyof BmdPersonenkontoRow]))
      .join(";")
  );

  return [headers.join(";"), ...csvRows].join("\n");
}

/**
 * Transaction data for export
 */
export interface TransactionForExport {
  id: string;
  date: Timestamp;
  amount: number; // in cents
  name?: string;
  partner?: string; // raw counterparty from bank CSV
  partnerName?: string; // resolved name from partnersMap
  partnerId?: string;
  fileIds?: string[];
  vatRate?: number;
  vatAmount?: number; // in cents
  vatId?: string;
  currency?: string | null;
  /** Manual reverse-charge flag / veto, read by the D3 classifier. */
  isReverseCharge?: boolean | null;
  noReceiptCategoryId?: string | null;
  noReceiptCategoryTemplateId?: string | null;
}

/**
 * File data for export.
 *
 * Beyond the fields the CSV itself prints, this carries the extraction fields
 * the VAT ladder reads (`FileRecord`, fork #66). They are optional: a caller
 * that omits them gets a transaction whose VAT is unresolvable, which books at
 * 0% rather than at a fabricated 20%.
 */
export interface FileForExport extends Omit<FileRecord, "id"> {
  id: string;
  fileName: string;
  extractedDate?: Timestamp;
}


/**
 * Book rows for one transaction, one per VAT rate on the document (fork #66).
 *
 * Two invariants the split must not break:
 *
 *  - The rows' `betrag` sums to the bank amount exactly. The derivation may
 *    return groups totalling LESS than the payment (a partial payment claims
 *    proportionally), but the booking still books the whole payment — so the
 *    document's rate MIX is applied to the full bank amount, which is what a
 *    bookkeeper does with an instalment. When the document reconciles, which is
 *    the ordinary case, the scaling is a no-op.
 *  - Rounding remainders land on the last row, so cents never go missing.
 *
 * `steuer` is recomputed from each row's own gross at its own rate rather than
 * copied from the group, because the group's figure belongs to the claimed
 * portion, not to the booked one.
 */
function splitByRate(
  bankGross: number,
  groups: RateGroup[]
): Array<{ rate: number; gross: number; vat: number }> {
  const totalGross = groups.reduce((sum, g) => sum + g.gross, 0);
  if (groups.length === 0 || totalGross <= 0) {
    return [{ rate: 0, gross: bankGross, vat: 0 }];
  }
  const rows: Array<{ rate: number; gross: number; vat: number }> = [];
  let assigned = 0;
  groups.forEach((g, i) => {
    const gross =
      i === groups.length - 1
        ? bankGross - assigned
        : Math.round((bankGross * g.gross) / totalGross);
    assigned += gross;
    rows.push({
      rate: g.rate,
      gross,
      vat: Math.round((gross * g.rate) / (100 + g.rate)),
    });
  });
  return rows;
}

/**
 * What the VAT derivation says about one transaction: the rows to book, or a
 * refusal that keeps the whole transaction out of the CSV (#194).
 *
 * A refusal is not an error. The run completes; the refused documents are
 * reported by name so the operator sees them before filing.
 */
type VatRowsResult =
  | { kind: "rows"; rows: Array<{ rate: number; gross: number; vat: number }> }
  | {
      kind: "refused";
      /** The documents that carry the offending figure, for the report. */
      fileIds: string[];
      reason: string;
    };

/**
 * The VAT rows for one transaction, read off the connected receipts.
 *
 * Runs the same ladder as the UVA report (`deriveTransactionVat`), so the two
 * trails cannot state different VAT for the same transaction — the divergence
 * fork #66 was filed about. Anything the ladder cannot resolve books at 0%: an
 * export must never assert input VAT that no document supports, and the old
 * `?? 20` asserted it on every undocumented line.
 *
 * One carve-out. A manually entered `vatAmount` is used verbatim when the user
 * also fixed the rate, because a typed amount is a stated fact rather than a
 * derivation, and the override lane has no way to express "this exact figure".
 */
function vatRowsFor(
  tx: TransactionForExport,
  files: Map<string, FileForExport>
): VatRowsResult {
  const bankGross = Math.abs(tx.amount);

  if (tx.vatRate != null && tx.vatAmount != null) {
    return { kind: "rows", rows: [{ rate: tx.vatRate, gross: bankGross, vat: tx.vatAmount }] };
  }

  const filesById = new Map<string, FileRecord>();
  for (const fid of tx.fileIds ?? []) {
    const f = files.get(fid);
    if (f) filesById.set(fid, f as FileRecord);
  }
  const categoriesById = new Map<string, CategoryRecord>();
  if (tx.noReceiptCategoryId) {
    categoriesById.set(tx.noReceiptCategoryId, {
      id: tx.noReceiptCategoryId,
      templateId: tx.noReceiptCategoryTemplateId ?? null,
    });
  }

  const uvaTx = buildUvaTransaction(
    {
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency ?? null,
      partner: tx.partnerName ?? tx.partner ?? null,
      vatRate: tx.vatRate ?? null,
      isReverseCharge: tx.isReverseCharge ?? null,
      noReceiptCategoryId: tx.noReceiptCategoryId ?? null,
      noReceiptCategoryTemplateId: tx.noReceiptCategoryTemplateId ?? null,
      fileIds: tx.fileIds,
    },
    { filesById, categoriesById }
  );

  const tip = assessTip(uvaTx.files, bankGross);

  // A tip that is not smaller than the payment is impossible on the document —
  // a Gesamt transcribed into the Trinkgeld field, or a bank line smaller than
  // the tip (#194). It used to fall through to `splitByRate(bankGross, groups)`
  // and stretch the rates over the whole charge, which is the exact export the
  // #172 branch below exists to prevent, silently. Refuse instead: the
  // transaction stays out of the CSV, the run still completes, and the reason
  // names the field to correct.
  //
  // Since #317 the ladder itself stops on the same predicate, so the ordinary
  // path arrives here as `unresolved`/`impossible-tip` — that is the UVA
  // refusing to claim the transaction, and the export refuses it too rather
  // than booking the 0% catch-all row at the bottom of this function. The
  // `groups` check below still stands because two lanes bypass the reconcile
  // and resolve anyway: an income line with `invoiceRateGroups`, and the D1
  // defaulted-20 fallback.
  const refuseImpossibleTip = (): VatRowsResult => ({
    kind: "refused",
    fileIds: tip.tipFiles.map((f) => f.id),
    reason:
      `tip (${formatBmdAmount(tip.tip)}) is not less than the bank amount ` +
      `(${formatBmdAmount(bankGross)}); correct the tip on this document and re-run`,
  });

  const derived = deriveTransactionVat(uvaTx);
  if (derived.kind === "unresolved" && derived.reason === "impossible-tip") {
    return refuseImpossibleTip();
  }
  if (derived.kind === "groups") {
    if (tip.impossible) return refuseImpossibleTip();
    // A printed Trinkgeld is a Betriebsausgabe and no part of the VAT base
    // (#172), so it books as its own 0% row instead of being scaled into the
    // rate groups. Without this, splitByRate would stretch the document's
    // rates over the tip too and the export would state VAT the UVA does not
    // — the fork #66 divergence, reintroduced.
    if (tip.tip > 0) {
      return {
        kind: "rows",
        rows: [
          ...splitByRate(bankGross - tip.tip, derived.groups),
          { rate: 0, gross: tip.tip, vat: 0 },
        ],
      };
    }
    return { kind: "rows", rows: splitByRate(bankGross, derived.groups) };
  }
  return { kind: "rows", rows: [{ rate: 0, gross: bankGross, vat: 0 }] };
}

/**
 * The Buchungen CSV plus the run's list of refused documents (#194).
 */
export interface BmdBuchungenResult {
  csv: string;
  /** Empty on a clean run. One entry per document that kept a transaction out. */
  skipped: BmdSkippedDocument[];
}

/**
 * Generate Buchungen CSV content
 *
 * The CSV alone, for callers that have nothing to do with a refusal — the
 * agreement and characterization suites, mostly. An export run wants
 * `generateBuchungenCsvWithReport`, because a run that drops a transaction
 * and says nothing is the failure #194 was filed about.
 */
export function generateBuchungenCsv(
  transactions: TransactionForExport[],
  files: Map<string, FileForExport>,
  partnerIndex: PartnerAccountIndex,
  startBelegnr: number = 1
): string {
  return generateBuchungenCsvWithReport(transactions, files, partnerIndex, startBelegnr).csv;
}

/**
 * Generate Buchungen CSV content, plus the documents the run refused to book.
 *
 * Skip and report: a transaction whose VAT cannot be stated honestly is left
 * out of the CSV rather than booked wrong, and every such document comes back
 * named, so the export run completes without the refusal being invisible.
 * Belegnummern still advance per transaction, refused ones included, so the
 * numbering agrees with `generateFileMapping`.
 */
export function generateBuchungenCsvWithReport(
  transactions: TransactionForExport[],
  files: Map<string, FileForExport>,
  partnerIndex: PartnerAccountIndex,
  startBelegnr: number = 1
): BmdBuchungenResult {
  const headers = [
    "satzart",
    "konto",
    "gkto",
    "belegnr",
    "buchdat",
    "belegdat",
    "betrag",
    "bucod",
    "steuer",
    "mwst",
    "text",
    "extbelegnr",
    "symbol",
    "uidnr",
  ];

  const rows: BmdBuchungRow[] = [];
  const skipped: BmdSkippedDocument[] = [];
  let belegnrCounter = startBelegnr;

  for (const tx of transactions) {
    const isExpense = tx.amount < 0;
    const isKreditor = isExpense;
    const hasFiles = tx.fileIds && tx.fileIds.length > 0;
    const templateId = tx.noReceiptCategoryTemplateId;
    const categoryMapping = templateId ? NO_RECEIPT_SACHKONTO_MAP[templateId] : undefined;
    const isCategoryTransaction = !!templateId && !!categoryMapping;

    // Skip zero-value category entirely
    if (templateId === "zero-value") {
      belegnrCounter++;
      continue;
    }

    // Get document date from first connected file, or use transaction date
    const firstFileId = tx.fileIds?.[0];
    const firstFile = firstFileId ? files.get(firstFileId) : undefined;
    const belegdat = firstFile?.extractedDate || tx.date;

    // Generate Belegnummer (YYYYNNNNNN format)
    const year = tx.date.toDate().getFullYear();
    const belegnr = `${year}${String(belegnrCounter).padStart(6, "0")}`;
    belegnrCounter++;

    // Preferred display name: resolved partner name > raw bank partner > tx name
    const displayName = tx.partnerName || tx.partner || tx.name || "";

    // External document reference (file names)
    const extbelegnr =
      tx.fileIds
        ?.map((fid) => files.get(fid)?.fileName)
        .filter(Boolean)
        .join(", ")
        .substring(0, 50) || "";

    // VAT comes off the receipts, via the same ladder the UVA report runs
    // (fork #66). A document carrying more than one rate produces more than one
    // booking row, all under this transaction's single Belegnummer — which is
    // how a split-rate receipt is booked, and why the counter advances per
    // transaction rather than per row.
    const vat = vatRowsFor(tx, files);

    // Refused (#194): no rows for this transaction at all — a partial booking
    // would be the same silent half-truth — and one report entry per document
    // that carries the figure.
    if (vat.kind === "refused") {
      for (const fid of vat.fileIds) {
        skipped.push({
          transactionId: tx.id,
          fileId: fid,
          fileName: files.get(fid)?.fileName || fid,
          reason: vat.reason,
        });
      }
      continue;
    }
    const vatRows = vat.rows;

    if (isCategoryTransaction && !hasFiles) {
      // --- No-receipt category path ---
      const sachkonto = (isExpense ? categoryMapping.expense : categoryMapping.income)
        || (isExpense ? "7000" : "4000"); // fallback

      const text = `${categoryMapping.name}: ${displayName}`.substring(0, 75);

      for (const v of vatRows) {
        rows.push({
          satzart: 0,
          konto: sachkonto,
          gkto: "", // empty — BMD assigns bank side on import
          belegnr,
          buchdat: formatBmdDate(tx.date),
          belegdat: formatBmdDate(belegdat),
          betrag: formatBmdAmount(v.gross),
          bucod: isExpense ? 1 : 2,
          steuer: formatBmdAmount(v.vat),
          mwst: v.rate,
          text,
          extbelegnr,
          symbol: categoryMapping.symbol || (isExpense ? "ER" : "AR"),
          uidnr: (tx.vatId || "").substring(0, 20),
        });
      }
    } else {
      // --- Standard transaction path (has files, or no category) ---
      const personenkonto = tx.partnerId
        ? generatePersonenkontoNumber(tx.partnerId, isKreditor, partnerIndex)
        : isKreditor
          ? String(KREDITOR_ACCOUNT_BASE + 1)
          : String(DEBITOR_ACCOUNT_BASE + 1);

      const contraAccount = isExpense ? "7000" : "4000";

      for (const v of vatRows) {
        rows.push({
          satzart: 0,
          konto: personenkonto,
          gkto: contraAccount,
          belegnr,
          buchdat: formatBmdDate(tx.date),
          belegdat: formatBmdDate(belegdat),
          betrag: formatBmdAmount(v.gross),
          bucod: isExpense ? 1 : 2,
          steuer: formatBmdAmount(v.vat),
          mwst: v.rate,
          text: displayName.substring(0, 75),
          extbelegnr,
          symbol: isExpense ? "ER" : "AR",
          uidnr: (tx.vatId || "").substring(0, 20),
        });
      }
    }
  }

  const csvRows = rows.map((row) =>
    headers
      .map((h) => escapeBmdCsv(row[h as keyof BmdBuchungRow]))
      .join(";")
  );

  return { csv: [headers.join(";"), ...csvRows].join("\n"), skipped };
}

/**
 * Generate a mapping of belegnr to file IDs for ZIP file naming
 */
export function generateFileMapping(
  transactions: TransactionForExport[],
  startBelegnr: number = 1
): Map<string, { belegnr: string; fileIds: string[] }> {
  const mapping = new Map<string, { belegnr: string; fileIds: string[] }>();
  let belegnrCounter = startBelegnr;

  for (const tx of transactions) {
    if (tx.fileIds && tx.fileIds.length > 0) {
      const year = tx.date.toDate().getFullYear();
      const belegnr = `${year}${String(belegnrCounter).padStart(6, "0")}`;
      mapping.set(tx.id, { belegnr, fileIds: tx.fileIds });
    }
    belegnrCounter++;
  }

  return mapping;
}
