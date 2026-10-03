/**
 * Adapter: Firestore records → pure UVA calculation input (fork #64).
 *
 * Lives api-side (admin SDK data shapes) but is itself pure: it takes plain
 * objects the callable has already fetched, so it stays testable without
 * Firestore. The two-container split means this file must not import
 * firebase-admin types on its surface either — Timestamps arrive as
 * anything with toDate().
 */

import {
  isPartialPaymentAcceptanceLive,
  type PartialPaymentAcceptance,
} from "./partialPaymentAcceptance";
import type {
  NonClaimableVatReason,
  UvaFile,
  UvaForeignRegime,
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
  extractedIssuer?: { vatId?: string | null } | null;
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
}

export interface CategoryRecord {
  id: string;
  templateId?: string | null;
  vatTreatment?: VatTreatment | null;
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

export interface BuildOptions {
  filesById: Map<string, FileRecord>;
  categoriesById: Map<string, CategoryRecord>;
  /** File id → fraction of the file's total already paid in earlier periods. */
  priorClaimedFractionByFileId?: Map<string, number>;
}

export function buildUvaTransaction(
  tx: TransactionRecord,
  opts: BuildOptions
): UvaTransaction {
  const files = (tx.fileIds ?? [])
    .map((id) => opts.filesById.get(id))
    .filter((f): f is FileRecord => !!f)
    .map(toUvaFile);

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
    priorClaimedFraction,
    partialPaymentAccepted: isPartialPaymentAcceptanceLive(tx, opts.filesById),
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
