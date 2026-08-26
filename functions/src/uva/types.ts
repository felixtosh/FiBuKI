/**
 * UVA calculation — pure data contracts (fork #64).
 *
 * Plain data in, report out. No Firestore types on this surface: the
 * two-container split means firebase/firestore (web) and firebase-admin
 * (api) types must never mix, so callers adapt their records to these
 * shapes before calling calculateUva.
 *
 * Spec: homelab work/finance/SPEC-uva-calculation.md (approved 2026-08-16).
 * All amounts are integer cents. All dates are ISO YYYY-MM-DD strings
 * denoting the Europe/Vienna calendar day of the bank movement (R3:
 * Ist-Besteuerung — the payment date decides the period).
 */

export interface UvaPeriod {
  year: number;
  /** 1-12 for monthly, 1-4 for quarterly */
  period: number;
  type: "monthly" | "quarterly";
}

/** One extracted line item, adapted from ExtractedLineItem. */
export interface UvaLineItem {
  description?: string | null;
  /** VAT rate (0-100), null when unknown */
  vatPercent: number | null;
  /** VAT amount in cents */
  vatAmount: number;
  /** Line amount in cents (gross) */
  amount: number;
}

/** A connected file, adapted from the files collection record. */
export interface UvaFile {
  id: string;
  /**
   * Document currency (extractedCurrency), ISO code; null/undefined = EUR.
   * A file whose currency differs from the transaction's is converted at the
   * effective rate actually paid (bank / totalGross) before derivation, and
   * only when that rate is a plausible FX rate for the pair (fork #87).
   */
  currency?: string | null;
  /** Document total in cents (extractedAmount) */
  totalGross?: number | null;
  /** Top-level extracted VAT amount in cents (extractedVatAmount) */
  vatAmount?: number | null;
  /** Top-level extracted VAT rate (extractedVatPercent) */
  vatPercent?: number | null;
  /** Surviving extracted line items (extractedLineItems) */
  lineItems?: UvaLineItem[] | null;
  /**
   * The document's own printed per-rate VAT summary block
   * (extractedRateGroups), validated on ingest (spec §6 item 3). When
   * present it outranks the line items: one transcribed subtotal per rate
   * beats a sum of N itemised rows, and §11 makes it sufficient alone.
   */
  rateGroups?: RateGroup[] | null;
  /**
   * Set by the extraction fix (spec §6) when line items failed document-total
   * reconciliation. Such a file is never trusted for LINE-ITEM derivation —
   * absent a printed rate-group block, the transaction goes to the review
   * bucket as amount-mismatch.
   */
  lineItemsUnreconciled?: boolean;
  /**
   * Spec §6 item 2: the rates whose printed group the line items failed to
   * reproduce, when the damage could be localised. Informational here —
   * derivation prefers `rateGroups` outright — but it is what tells a human
   * which line to repair.
   */
  lineItemsUnreconciledRates?: number[] | null;
  /** Supplier VAT ID (extractedIssuer.vatId ?? extractedVatId), e.g. ATU…, DE… */
  supplierVatId?: string | null;
}

/** vatTreatment attribute on no-receipt categories (spec §3 step 0). */
export type VatTreatment =
  | "exempt-class"
  | "documented-elsewhere"
  | "needs-receipt";

/**
 * D3 foreign-regime classification, provided by the caller (heuristic or
 * manual override). The three regimes must never share a bucket:
 *  - service (any origin)      → reverse charge §19, KZ 057/066
 *  - goods + eu                → ig. Erwerb, KZ 070 + per-rate base + KZ 065
 *  - goods + third-country     → import, KZ 061/083 (needs documented EUSt)
 */
export interface UvaForeignRegime {
  kind: "service" | "goods";
  origin: "eu" | "third-country";
  basis: "heuristic" | "override";
  /**
   * service and goods/eu: the Austrian rate the supply would carry
   * domestically (default 20) — the self-assessment rate.
   * goods/third-country: ignored.
   */
  domesticRate?: number | null;
  /** goods/third-country only: Einfuhrumsatzsteuer actually paid, cents. */
  importVatPaid?: number | null;
  /**
   * goods/third-country only: how the EUSt was settled — "paid" (KZ 061,
   * default) or "deferred" via §26 Abs 3 Z 2 charge to the tax account
   * (KZ 083).
   */
  importVatScheme?: "paid" | "deferred" | null;
}

/** Per-rate group: the atom of derivation (R4/R6). */
export interface RateGroup {
  /** VAT rate 0-100 */
  rate: number;
  /** Net amount, cents */
  net: number;
  /** VAT amount, cents */
  vat: number;
  /** Gross amount, cents */
  gross: number;
}

export interface UvaTransaction {
  id: string;
  /** Europe/Vienna calendar day of the bank movement, YYYY-MM-DD */
  date: string;
  /** Signed cents: negative = expense, positive = income */
  amount: number;
  /** Bank-line currency, ISO code; null/undefined = EUR. */
  currency?: string | null;
  partnerName?: string | null;
  /** Restaurant-class partner enables tip-delta classification (R5). */
  partnerClass?: "restaurant" | null;
  /** Manual override lane (tx.vatRate) — spec §3 step 3. */
  vatRateOverride?: number | null;
  /** Assigned no-receipt category, with its vatTreatment when set. */
  noReceiptCategory?: {
    id: string;
    templateId?: string | null;
    vatTreatment?: VatTreatment | null;
  } | null;
  /** Connected files (already fetched by the caller). */
  files?: UvaFile[];
  /**
   * Income only: rate groups of the linked outgoing Fibuki invoice —
   * resolves output VAT before the defaulted-20 fallback fires.
   */
  invoiceRateGroups?: RateGroup[] | null;
  /** D3 classification; null/undefined = domestic. */
  foreignRegime?: UvaForeignRegime | null;
  /**
   * Instalments: fraction of the connected file's total already claimed by
   * transactions in EARLIER periods (0-1). This period's claim is capped so
   * the file's cumulative claimed fraction never exceeds 1.
   */
  priorClaimedFraction?: number | null;
}

export type DerivationStep =
  /** The document's own printed per-rate VAT summary block (spec §6 item 3) */
  | "rate-groups"
  | "line-items"
  | "top-level"
  | "override"
  | "invoice"
  | "defaulted-20"
  | "exempt-class"
  | "reverse-charge"
  | "eu-acquisition"
  | "import";

export type UnresolvedReason =
  | "no-file"
  | "no-vat-data"
  | "foreign-or-invalid-rate"
  | "amount-mismatch"
  /**
   * The document is in another currency than the bank line and no effective
   * rate could be derived: several files on one payment, no document total,
   * an unknown currency, or an implied rate that is not a plausible FX rate
   * (fork #87). The document figures are NOT used — they would be read in
   * the wrong unit.
   */
  | "foreign-currency"
  | "needs-receipt";

/** The pre-filing human checklist (spec §5). */
export interface UnresolvedEntry {
  transactionId: string;
  date: string;
  partner: string | null;
  /** Signed cents as on the bank line */
  amount: number;
  side: "income" | "expense";
  reason: UnresolvedReason;
  /**
   * Foregone input VAT where a rate guess exists (cents) — the value of
   * chasing this receipt. Null when no guess is possible.
   */
  foregoneVat: number | null;
  /** Income only: output VAT that was defaulted at 20% (cents). */
  defaultedOutputVat?: number;
}

export interface ForeignVatEntry {
  transactionId: string;
  fileId?: string;
  supplierVatId: string | null;
  /** Signed bank cents */
  amount: number;
  /** The foreign rate seen on the document, if any */
  rate: number | null;
  /** EU refund procedure candidate (D2) */
  refundCandidate: boolean;
}

export interface ReverseChargeEntry {
  transactionId: string;
  base: number;
  vat: number;
  origin: "eu" | "third-country";
  basis: "heuristic" | "override";
}

export interface KennzahlFigure {
  /** Cents */
  value: number;
  /** Contributing transaction counts by derivation step (spec §5). */
  contributions: Partial<Record<DerivationStep, number>>;
}

export interface UvaReportResult {
  period: UvaPeriod & {
    /** First calendar day of the period, YYYY-MM-DD */
    start: string;
    /** Last calendar day of the period, YYYY-MM-DD */
    end: string;
    timezone: "Europe/Vienna";
    /** Rate set in force during the period (R1) */
    rateSet: number[];
  };
  /**
   * Figures keyed by Kennzahl ("000", "022", …). Only spec-§4 codes are
   * ever emitted; KZ096 does not exist and must never appear.
   */
  kennzahlen: Record<string, KennzahlFigure>;
  /** Output VAT per rate (tax is computed from base on the U30; this is provenance). */
  outputVatByRate: Array<{ rate: number; base: number; vat: number }>;
  totalOutputVat: number;
  totalInputVat: number;
  /** KZ095: Zahllast (>0) / Gutschrift (<0), single netted figure. */
  balance: number;
  unresolved: UnresolvedEntry[];
  foreignVat: ForeignVatEntry[];
  reverseCharge: ReverseChargeEntry[];
  /** Spec §3: EU Kennzahlen are structurally-empty-with-reason until real detection lands. */
  euKennzahlen: { basis: "not-implemented" | "measured" };
}

export interface UvaCalculationInput {
  period: UvaPeriod;
  /**
   * All candidate transactions; the module filters to the period by date
   * string comparison (timezone-proof — §7).
   */
  transactions: UvaTransaction[];
}
