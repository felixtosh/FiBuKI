/**
 * Adapter: Firestore records → pure UVA calculation input (fork #64).
 *
 * Lives api-side (admin SDK data shapes) but is itself pure: it takes plain
 * objects the callable has already fetched, so it stays testable without
 * Firestore. The two-container split means this file must not import
 * firebase-admin types on its surface either — Timestamps arrive as
 * anything with toDate().
 */

import { filePaymentTotal } from "../matching/coverage";
import { countedDocuments } from "../matching/countedDocuments";
import {
  isPartialPaymentAcceptanceLive,
  type PartialPaymentAcceptance,
} from "./partialPaymentAcceptance";
import type {
  NonClaimableVatReason,
  UvaCorrection,
  SaleSupplyKind,
  UvaFile,
  UvaForeignRegime,
  UvaSaleSupply,
  UvaTransaction,
  VatTreatment,
} from "./types";

/** Minimal shape of a stored transaction this adapter reads. */
export interface TransactionRecord {
  id: string;
  date: TimestampLike;
  amount: number;
  currency?: string | null;
  partner?: string | null;
  vatRate?: number | null;
  isReverseCharge?: boolean | null;
  /**
   * A person's goods/service answer to the foreign-regime review (#214).
   * Unset/null keeps the service heuristic below exactly as it was.
   */
  foreignSupplyKind?: "goods" | "service" | null;
  /**
   * A person's answer to what a 0% sale is (#565), the income-side mirror of
   * `foreignSupplyKind`. Wins over the Invoice setting and over detection.
   */
  saleSupplyKind?: SaleSupplyKind | null;
  /** The assigned Partner, whose country is the last customer-country signal (#565). */
  partnerId?: string | null;
  noReceiptCategoryId?: string | null;
  noReceiptCategoryTemplateId?: string | null;
  fileIds?: string[];
  /**
   * Accepted Partial Payment (#554), as stored. Read only through
   * `isPartialPaymentAcceptanceLive`: a ruling over figures that have since
   * changed lets nothing through.
   */
  partialPaymentAcceptance?: PartialPaymentAcceptance | null;
}

/** Minimal shape of a stored file record this adapter reads. */
export interface FileRecord {
  id: string;
  extractedAmount?: number | null;
  extractedTipAmount?: number | null;
  extractedCurrency?: string | null;
  extractedVatAmount?: number | null;
  extractedVatPercent?: number | null;
  extractedLineItems?: Array<{
    description?: string | null;
    vatPercent: number | null;
    vatAmount: number;
    amount: number;
  }> | null;
  extractedRateGroups?: Array<{
    rate: number;
    net: number;
    vat: number;
    gross: number;
  }> | null;
  lineItemsUnreconciled?: boolean;
  lineItemsUnreconciledRates?: number[] | null;
  extractedVatId?: string | null;
  extractedIssuer?: { vatId?: string | null; country?: string | null } | null;
  /** The bill-to party; the customer on a sale (#565). */
  extractedRecipient?: { vatId?: string | null; country?: string | null } | null;
  /** Which party is the user: "issuer" on a sale, "recipient" on a purchase. */
  matchedUserAccount?: "issuer" | "recipient" | null;
  /** ISO country of the counterparty (#540). */
  extractedCountry?: string | null;
  /** The document's printed total VAT, cents (#540); null when none is printed. */
  extractedDocumentVatAmount?: number | null;
  /** The invoice date: the service date of a sale, for the ZM (#565). */
  extractedDate?: TimestampLike | null;
  /** A FiBuKI Invoice's document (ADR-0006), as opposed to an uploaded one. */
  isFibukiGenerated?: boolean;
  /**
   * A FiBuKI Invoice issued with "Service, place of supply abroad (§ 3a
   * Abs 6)" set (#565), resolved to the customer's region at issue.
   */
  invoiceSupplyKind?: "service-eu" | "service-non-eu" | null;
  /**
   * A human's standing decision that this document's VAT is not deductible
   * (#203). The reason IS the marker — there is no separate boolean, so the
   * fact and the why cannot drift apart.
   */
  vatNotClaimableReason?: NonClaimableVatReason | null;
  /**
   * The § 11 classifier found this document addressed to somebody who is not
   * the user (#229). Written by `documentTypeFields`, read here because the
   * consequence is a § 12 one: there is no Vorsteuer to claim.
   */
  foreignRecipient?: boolean;
  /**
   * The invoice this File is the Receipt of (#571, ADR-0012). Beside its
   * invoice on one Transaction, the pair counts as one document.
   */
  receiptLink?: { fileId?: string | null } | null;
}

export interface CategoryRecord {
  id: string;
  templateId?: string | null;
  vatTreatment?: VatTreatment | null;
}

/** The Partner fields the customer-country fallback reads (#565). */
export interface PartnerRecord {
  id: string;
  country?: string | null;
}

export interface TimestampLike {
  toDate(): Date;
}

/**
 * Default vatTreatment per hardcoded template (spec §3 step 0 / R9).
 * An explicit vatTreatment on the user's category record wins.
 *
 *  - exempt-class:          zero input VAT by law, nothing to chase
 *  - documented-elsewhere:  outside this report's scope (transfers,
 *                           private, settlements covered by underlying
 *                           invoices, zero-value entries)
 *  - needs-receipt:         an Eigenbeleg never creates a VAT deduction
 *                           (D1) — stays on the chasing worklist
 */
export const TEMPLATE_VAT_TREATMENT: Record<string, VatTreatment> = {
  "bank-fees": "exempt-class",
  interest: "exempt-class",
  // Interest-like bonuses the bank itself pays (§ 6 (1) 8 UStG): the bank
  // statement line is the document, and there is no VAT in either direction
  // (#169). Cashback and referral bonuses stay on the default lane.
  "bank-rewards": "exempt-class",
  "taxes-government": "exempt-class",
  payroll: "exempt-class",
  "internal-transfers": "documented-elsewhere",
  "payment-provider-settlements": "documented-elsewhere",
  "private-personal": "documented-elsewhere",
  "zero-value": "documented-elsewhere",
  "receipt-lost": "needs-receipt",
};

/**
 * Stored dates are UTC-midnight of the Vienna calendar day on both ingest
 * paths, so the calendar day is the UTC date part — no host timezone is
 * consulted (the §7 bug class).
 */
export function toViennaCalendarDay(date: TimestampLike): string {
  return date.toDate().toISOString().slice(0, 10);
}

export function toUvaFile(f: FileRecord): UvaFile {
  return {
    id: f.id,
    currency: f.extractedCurrency ?? null,
    totalGross: f.extractedAmount ?? null,
    tipAmount: f.extractedTipAmount ?? null,
    vatAmount: f.extractedVatAmount ?? null,
    vatPercent: f.extractedVatPercent ?? null,
    lineItems: f.extractedLineItems ?? null,
    rateGroups: f.extractedRateGroups ?? null,
    lineItemsUnreconciled: f.lineItemsUnreconciled ?? false,
    lineItemsUnreconciledRates: f.lineItemsUnreconciledRates ?? null,
    supplierVatId: f.extractedIssuer?.vatId ?? f.extractedVatId ?? null,
    // A reason a human recorded outranks the derived one: both keep the VAT
    // out, and the human's says something the rule does not know.
    nonClaimableVatReason:
      f.vatNotClaimableReason ?? (f.foreignRecipient === true ? "foreign-recipient" : null),
  };
}

const EU_UID_PREFIXES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK", "XI",
]);

/**
 * D3 classification. The signals, in order:
 *  - tx.isReverseCharge === true is a manual/override signal that a foreign
 *    regime applies at all;
 *  - tx.isReverseCharge === false is a manual VETO of everything foreign;
 *  - a foreign supplier UID on a document that charges no VAT is the
 *    heuristic signal (Anthropic pattern: US/IE supplier, 0% VAT line);
 *  - tx.foreignSupplyKind (#214) is a person's goods/service answer to
 *    the review flag. It decides the KIND of an otherwise-detected foreign
 *    supply and turns the basis into "override" - it never conjures a
 *    regime where neither the override nor the heuristic found one.
 * Unset foreignSupplyKind keeps the service heuristic exactly as it was,
 * flagged basis: "heuristic" in the reverse-charge list for human review.
 * A goods/third-country classification reaches the import lane, which the
 * calculator leaves unresolved until EUSt is documented (`importVatPaid`).
 */
export function deriveForeignRegime(
  tx: TransactionRecord,
  files: UvaFile[]
): UvaForeignRegime | null {
  if (tx.amount >= 0) return null;
  if (tx.isReverseCharge === false) return null;

  const foreignUidFile = files.find((f) => {
    const uid = f.supplierVatId?.toUpperCase();
    return uid && /^[A-Z]{2}/.test(uid) && !uid.startsWith("ATU");
  });
  const origin = (uid: string | null | undefined): "eu" | "third-country" =>
    uid && EU_UID_PREFIXES.has(uid.toUpperCase().slice(0, 2))
      ? "eu"
      : "third-country";
  const kindOverride = tx.foreignSupplyKind ?? null;

  if (tx.isReverseCharge === true) {
    return {
      kind: kindOverride ?? "service",
      origin: origin(foreignUidFile?.supplierVatId),
      basis: "override",
    };
  }

  if (foreignUidFile) {
    const chargesNoVat = files.every(
      (f) => !f.vatAmount && !f.vatPercent &&
        !(f.lineItems ?? []).some((li) => (li.vatPercent ?? 0) > 0 || li.vatAmount > 0)
    );
    if (chargesNoVat) {
      return kindOverride
        ? {
            kind: kindOverride,
            origin: origin(foreignUidFile.supplierVatId),
            basis: "override",
          }
        : {
            kind: "service",
            origin: origin(foreignUidFile.supplierVatId),
            basis: "heuristic",
          };
    }
  }
  return null;
}

/**
 * EU member states for the place-of-supply question (#565), as ISO codes. This
 * is not `EU_UID_PREFIXES`: Northern Ireland (XI) is inside the EU for goods
 * only, so a service to an XI business is a non-EU service, like one to GB.
 */
const EU27_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
]);

function isoCountry(raw: string | null | undefined): string | null {
  const c = raw?.trim().toUpperCase();
  return c && /^[A-Z]{2}$/.test(c) ? c : null;
}

/** A UID's country: its prefix, except Greece, whose UIDs start EL. */
function uidCountry(uid: string | null | undefined): string | null {
  const prefix = isoCountry(uid?.trim().slice(0, 2));
  return prefix === "EL" ? "GR" : prefix;
}

/** A customer's country: the UID prefix first, the stated country second (#565). */
export function customerCountry(
  customerVatId: string | null | undefined,
  country: string | null | undefined
): string | null {
  return uidCountry(customerVatId) ?? isoCountry(country);
}

/**
 * EU or not, for a service sold to a business there (#565). The UID prefix
 * decides first, the country second; null when neither is known.
 */
export function serviceRegionOf(
  customerVatId: string | null | undefined,
  country: string | null | undefined
): "eu" | "non-eu" | null {
  const c = customerCountry(customerVatId, country);
  if (!c) return null;
  return EU27_COUNTRIES.has(c) ? "eu" : "non-eu";
}

/** The party on a document that is not the user: the customer, on a sale. */
function customerOf(f: FileRecord) {
  return f.matchedUserAccount === "recipient" ? f.extractedIssuer : f.extractedRecipient;
}

/**
 * What a sale's 0% part is (#565). Precedence: the person's override on the
 * Transaction, then the setting on a FiBuKI Invoice, then detection, then
 * undetermined. Resolved for every money-in Transaction; the calculation
 * reads it only for a 0% rate group, so a kind on a 20% sale changes nothing.
 *
 * Detection reads only Files that are not FiBuKI Invoices: no VAT printed and
 * a customer outside Austria. The customer's country is the UID prefix, then
 * the File's extracted country, then the Partner's. A FiBuKI Invoice issued
 * without the setting stays undetermined: what it says is the setting.
 */
export function deriveSaleSupply(
  tx: TransactionRecord,
  files: FileRecord[],
  partner: PartnerRecord | undefined
): UvaSaleSupply | null {
  if (tx.amount <= 0) return null;

  const invoiceFile = files.find((f) => f.isFibukiGenerated && f.invoiceSupplyKind);
  const uploaded = files.filter((f) => !f.isFibukiGenerated);
  const named = [invoiceFile, ...files].find((f) => f && (customerOf(f)?.vatId || f.extractedVatId));
  const customerVatId = named ? customerOf(named)?.vatId || named.extractedVatId || null : null;
  const dated = [invoiceFile, ...files].find((f) => f?.extractedDate);
  const serviceDate = dated?.extractedDate ? toViennaCalendarDay(dated.extractedDate) : null;
  const facts = { customerVatId, serviceDate };

  if (tx.saleSupplyKind) return { kind: tx.saleSupplyKind, basis: "manual", ...facts };
  if (invoiceFile?.invoiceSupplyKind) {
    return { kind: invoiceFile.invoiceSupplyKind, basis: "invoice", ...facts };
  }

  const printsNoVat = (f: FileRecord) =>
    !((f.extractedDocumentVatAmount ?? 0) > 0) && !((f.extractedVatAmount ?? 0) > 0);
  if (uploaded.length > 0 && uploaded.every(printsNoVat)) {
    const withCountry = uploaded.find((f) => customerOf(f)?.country || f.extractedCountry);
    const country =
      uidCountry(customerVatId) ??
      isoCountry(withCountry ? customerOf(withCountry)?.country || withCountry.extractedCountry : null) ??
      isoCountry(partner?.country);
    if (country && country !== "AT") {
      const region = serviceRegionOf(null, country);
      return { kind: region === "eu" ? "service-eu" : "service-non-eu", basis: "detected", ...facts };
    }
  }
  return { kind: "undetermined", basis: null, ...facts };
}

/**
 * What paying a document in full comes to, cents: its total plus its tip
 * (#172). The instalment cap divides what earlier periods paid by this, the
 * same figure the reconcile measures a payment against; dividing by the total
 * alone made a ruled split bill's second half look over-paid (#554). Null for
 * a document with no positive total, which is never read as an instalment.
 */
export function payableTotalOf(
  f: Pick<FileRecord, "extractedAmount" | "extractedTipAmount"> | undefined
): number | null {
  const total = f?.extractedAmount ?? 0;
  if (total <= 0) return null;
  const tip = f?.extractedTipAmount ?? 0;
  return total + (tip > 0 ? tip : 0);
}

/**
 * A Transaction's Files as the documents it counts (#571, ADR-0012): a
 * Receipt beside the invoice it pays is folded into the invoice, and the
 * Receipt's surplus over the invoice joins the invoice's Trinkgeld, so it is
 * part of the payment and no part of the VAT base, and the tip guards judge
 * it like a printed one. The Receipt's own figures never reach the
 * calculation, so neither its VAT nor the prior-instalment lookup sees it.
 */
export function countedFileRecords(records: FileRecord[]): FileRecord[] {
  if (!records.some((f) => f.receiptLink?.fileId)) return records;
  const documents = countedDocuments(
    records.map((record) => ({
      record,
      id: record.id,
      payment: filePaymentTotal(record.extractedAmount, record.extractedTipAmount),
      currency: record.extractedCurrency ?? null,
      receiptOfFileId: record.receiptLink?.fileId ?? null,
    }))
  );
  return documents.map(({ file: { record }, surplus }) => {
    if (surplus <= 0) return record;
    const printed = record.extractedTipAmount ?? 0;
    return { ...record, extractedTipAmount: (printed > 0 ? printed : 0) + surplus };
  });
}

export interface BuildOptions {
  filesById: Map<string, FileRecord>;
  categoriesById: Map<string, CategoryRecord>;
  /** File id → fraction of the file's total already paid in earlier periods. */
  priorClaimedFractionByFileId?: Map<string, number>;
  /**
   * Transaction id → its correction, resolved by the period run (#564). A
   * Transaction absent here is an ordinary sale or purchase.
   */
  correctionByTransactionId?: Map<string, UvaCorrection>;
  /** Partners by id, for the customer-country fallback (#565). */
  partnersById?: Map<string, PartnerRecord>;
}

export function buildUvaTransaction(
  tx: TransactionRecord,
  opts: BuildOptions
): UvaTransaction {
  const fileRecords = countedFileRecords(
    (tx.fileIds ?? []).map((id) => opts.filesById.get(id)).filter((f): f is FileRecord => !!f)
  );
  const files = fileRecords.map(toUvaFile);

  let noReceiptCategory: UvaTransaction["noReceiptCategory"] = null;
  if (tx.noReceiptCategoryId) {
    const cat = opts.categoriesById.get(tx.noReceiptCategoryId);
    const templateId = cat?.templateId ?? tx.noReceiptCategoryTemplateId ?? null;
    noReceiptCategory = {
      id: tx.noReceiptCategoryId,
      templateId,
      vatTreatment:
        cat?.vatTreatment ??
        (templateId ? TEMPLATE_VAT_TREATMENT[templateId] ?? null : null),
    };
  }

  // A transaction only claims an instalment fraction when its files carry
  // prior-period payments; several files with priors are summed by weight.
  let priorClaimedFraction: number | null = null;
  if (opts.priorClaimedFractionByFileId) {
    for (const f of files) {
      const prior = opts.priorClaimedFractionByFileId.get(f.id);
      if (prior && prior > 0) priorClaimedFraction = Math.min((priorClaimedFraction ?? 0) + prior, 1);
    }
  }

  return {
    id: tx.id,
    date: toViennaCalendarDay(tx.date),
    amount: tx.amount,
    currency: tx.currency ?? null,
    partnerName: tx.partner ?? null,
    vatRateOverride: tx.vatRate ?? null,
    noReceiptCategory,
    files,
    foreignRegime: deriveForeignRegime(tx, files),
    saleSupply: deriveSaleSupply(
      tx,
      fileRecords,
      tx.partnerId ? opts.partnersById?.get(tx.partnerId) : undefined
    ),
    priorClaimedFraction,
    partialPaymentAccepted: isPartialPaymentAcceptanceLive(tx, opts.filesById),
    correction: opts.correctionByTransactionId?.get(tx.id) ?? null,
    // invoiceRateGroups stays unset: the data model has no
    // invoice↔transaction link yet. Income resolves via connected files
    // (uploaded AR invoices) or falls back per spec §3 step 4; the pure
    // module already supports invoice groups for when linkage lands.
  };
}

export function buildUvaTransactions(
  txs: TransactionRecord[],
  opts: BuildOptions
): UvaTransaction[] {
  return txs.map((tx) => buildUvaTransaction(tx, opts));
}
