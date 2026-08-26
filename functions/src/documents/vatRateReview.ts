/**
 * Detector: a document printing a VAT rate Austria does not have (#203).
 *
 * The live corpus holds exactly one — a Filmproduktionshaftpflicht at 11%,
 * which is Versicherungssteuer rather than VAT. It was found by sweeping every
 * file by hand. This is the rule that makes the next one arrive already
 * flagged: whatever prints an unexpected rate lands in a queryable queue
 * instead of waiting for another sweep.
 *
 * Pure data in, verdict out — the same discipline as `classifyDocumentType`,
 * and for the same reason: a rule about tax has to be testable exhaustively
 * without fixtures.
 *
 * The accepted set is `ratesValidOn(the document's date)`, so this cannot
 * disagree with the UVA derivation about what an Austrian rate is. On any date
 * before BGBl I 37/2026 adds 4.9% that set is exactly 0/10/13/20; the one
 * further exception is the 19% Jungholz/Mittelberg enclave rate (§10 Abs 4),
 * accepted here on an Austrian supplier UID because derivation accepts it as
 * claimable there. Everything else the derivation refuses, this flags.
 */

import { KNOWN_AUSTRIAN_RATES, ratesValidOn } from "../uva/rateSet";

/** The rate-bearing facts extraction produces, as far as this rule cares. */
export interface VatRateFacts {
  /**
   * Document date as a Vienna calendar day, YYYY-MM-DD. null when unknown —
   * the rate set then widens to every rate that is EVER Austrian, so a missing
   * date can never manufacture a flag.
   */
  date?: string | null;
  /** Top-level extracted VAT rate (0-100). */
  vatPercent?: number | null;
  /** The document's own printed per-rate VAT summary block. */
  rateGroups?: Array<{ rate?: number | null }> | null;
  lineItems?: Array<{ vatPercent?: number | null }> | null;
  /** Supplier UID; an ATU prefix is what makes 19% lawful (§10 Abs 4). */
  supplierVatId?: string | null;
  /** Already ruled out as a financial document — it prints no rate to judge. */
  isNotInvoice?: boolean;
}

export interface VatRateReviewResult {
  /**
   * Every rate the document prints that is not an Austrian VAT rate on its
   * date, deduplicated and ascending. Empty means nothing to look at.
   */
  ratesOutsideSet: number[];
  /** True exactly when `ratesOutsideSet` is non-empty. */
  needsReview: boolean;
}

export function reviewVatRates(facts: VatRateFacts): VatRateReviewResult {
  if (facts.isNotInvoice) {
    return { ratesOutsideSet: [], needsReview: false };
  }

  const accepted = facts.date ? ratesValidOn(facts.date) : KNOWN_AUSTRIAN_RATES;
  const enclaveOk = isAustrianUid(facts.supplierVatId);

  const printed: number[] = [];
  const add = (rate: unknown) => {
    if (typeof rate === "number" && Number.isFinite(rate)) printed.push(rate);
  };
  add(facts.vatPercent);
  for (const g of facts.rateGroups ?? []) add(g?.rate);
  for (const li of facts.lineItems ?? []) add(li?.vatPercent);

  const outside = new Set<number>();
  for (const rate of printed) {
    if (accepted.includes(rate)) continue;
    if (rate === 19 && enclaveOk) continue;
    outside.add(rate);
  }

  const ratesOutsideSet = [...outside].sort((a, b) => a - b);
  return { ratesOutsideSet, needsReview: ratesOutsideSet.length > 0 };
}

/** A files-collection record, as loosely as this module needs to read one. */
type FileRecord = Record<string, unknown>;

/**
 * The document date is a Firestore Timestamp on the record and an ISO string
 * nowhere. Stored dates are UTC-midnight of the Vienna calendar day on both
 * ingest paths, so the calendar day is the UTC date part (the §7 bug class).
 */
function toCalendarDay(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10) || null;
  const withToDate = value as { toDate?: () => Date };
  if (typeof withToDate.toDate === "function") {
    const date = withToDate.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString().slice(0, 10)
      : null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  return null;
}

export function toVatRateFacts(record: FileRecord): VatRateFacts {
  const issuer = (record.extractedIssuer ?? {}) as { vatId?: unknown };
  const issuerVatId = typeof issuer.vatId === "string" ? issuer.vatId : null;
  const flatVatId = typeof record.extractedVatId === "string" ? record.extractedVatId : null;

  return {
    date: toCalendarDay(record.extractedDate),
    vatPercent:
      typeof record.extractedVatPercent === "number" ? record.extractedVatPercent : null,
    rateGroups: Array.isArray(record.extractedRateGroups)
      ? (record.extractedRateGroups as Array<{ rate?: number | null }>)
      : null,
    lineItems: Array.isArray(record.extractedLineItems)
      ? (record.extractedLineItems as Array<{ vatPercent?: number | null }>)
      : null,
    supplierVatId: issuerVatId ?? flatVatId,
    isNotInvoice: record.isNotInvoice === true,
  };
}

/**
 * The fields a rate review writes onto a file record.
 *
 * Persisted rather than recomputed at read time, for the same reason the § 11
 * classification is: two readers must not be able to disagree about the same
 * document. `needsVatRateReview` is the queryable flag; the rates themselves
 * are what tells a human what they are looking at before opening the PDF.
 */
export function vatRateReviewFields(result: VatRateReviewResult): Record<string, unknown> {
  return {
    needsVatRateReview: result.needsReview,
    vatRatesOutsideSet: result.ratesOutsideSet,
  };
}

/** Review a stored file record. */
export function reviewFileRecordVatRates(record: FileRecord): VatRateReviewResult {
  return reviewVatRates(toVatRateFacts(record));
}

function isAustrianUid(uid: string | null | undefined): boolean {
  return !!uid && uid.toUpperCase().startsWith("ATU");
}
