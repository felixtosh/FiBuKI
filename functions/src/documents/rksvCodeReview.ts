/**
 * Detector: a printed Rate Group block the RKSV Code contradicts (#166).
 *
 * A receipt that prints its own Rate Group block and carries an RKSV Code
 * holds two readings of the same split. The printed block is what is stored:
 * while the model decodes the QR, the code is a reading like any other, and a
 * misread code that happens to add up must not overwrite a correct
 * transcription. What was missing is that nobody was told when the two
 * disagree. A transposed 10 % and 13 % is a plausible receipt with the wrong
 * Vorsteuer, so the disagreement becomes a stored review flag, the same shape
 * as `vatRateReview` (#203), `directionReview` (#233) and `repairReview` (#275).
 *
 * Only Normal (20 %), Ermäßigt-1 (10 %) and Ermäßigt-2 (13 %) are compared:
 * they name one rate each. Null and Besonders do not, so a printed rate that
 * falls into one of them has nothing in the code to be compared with.
 *
 * Pure data in, verdict out. The stored code payloads are parsed again rather
 * than trusted, so a File stored under an older parsed shape (#540) is judged
 * by the current rules.
 */

import { parseQrPayloads, usableRksvCode } from "../extraction/qrCodes";

/** The rates the code states without ambiguity. */
const COMPARED_RATES = [20, 10, 13] as const;

/** Where a File's stored Rate Groups came from. */
export type RateGroupsSource = "document" | "rksvCode";

/** The facts this rule reads off a file record. */
export interface RksvCodeFacts {
  /** The stored QR codes: parsed objects or raw payloads, as stored. */
  qrCodes?: unknown[] | null;
  /** The stored Rate Groups. */
  rateGroups?: Array<{ rate?: number | null; gross?: number | null }> | null;
  /**
   * Where the stored Rate Groups came from. Only a printed block is compared:
   * groups taken from the code cannot disagree with it, and a record stored
   * before the source existed says nothing either way.
   */
  rateGroupsSource?: RateGroupsSource | null;
  /** The document total, cents: the code is usable only when it adds up to it. */
  documentTotal?: number | null;
  /** Already ruled out as a financial document. */
  isNotInvoice?: boolean;
}

export interface RksvCodeReviewResult {
  /** The rates at which the printed block and the code differ, ascending. */
  disagreeingRates: number[];
  /** True exactly when `disagreeingRates` is non-empty. */
  needsReview: boolean;
}

const NOTHING: RksvCodeReviewResult = { disagreeingRates: [], needsReview: false };

export function reviewRksvCode(facts: RksvCodeFacts): RksvCodeReviewResult {
  if (facts.isNotInvoice || facts.rateGroupsSource !== "document") return NOTHING;
  const groups = facts.rateGroups ?? [];
  if (groups.length === 0) return NOTHING;

  const code = usableRksvCode(parseQrPayloads(facts.qrCodes ?? []), facts.documentTotal);
  if (!code?.grossByRate) return NOTHING;

  const disagreeingRates = COMPARED_RATES.filter((rate) => {
    const inCode = code.grossByRate
      ?.filter((bucket) => bucket.rate === rate)
      .reduce((acc, bucket) => acc + bucket.gross, 0) ?? 0;
    const printed = groups
      .filter((group) => group?.rate === rate)
      .reduce((acc, group) => acc + (typeof group?.gross === "number" ? group.gross : 0), 0);
    return inCode !== printed;
  });

  return { disagreeingRates, needsReview: disagreeingRates.length > 0 };
}

/** A files-collection record, as loosely as this module needs to read one. */
type FileRecord = Record<string, unknown>;

export function toRksvCodeFacts(record: FileRecord): RksvCodeFacts {
  const source = record.extractedRateGroupsSource;
  return {
    qrCodes: Array.isArray(record.extractedQrCodes) ? record.extractedQrCodes : null,
    rateGroups: Array.isArray(record.extractedRateGroups)
      ? (record.extractedRateGroups as RksvCodeFacts["rateGroups"])
      : null,
    rateGroupsSource: source === "document" || source === "rksvCode" ? source : null,
    documentTotal: typeof record.extractedAmount === "number" ? record.extractedAmount : null,
    isNotInvoice: record.isNotInvoice === true,
  };
}

/**
 * The fields an RKSV Code review writes onto a file record. Persisted rather
 * than recomputed at read time, like its siblings: `needsRksvCodeReview` is
 * the queryable flag, and the rates tell a human where to look on the paper.
 */
export function rksvCodeReviewFields(result: RksvCodeReviewResult): Record<string, unknown> {
  return {
    needsRksvCodeReview: result.needsReview,
    rksvCodeDisagreeingRates: result.disagreeingRates,
  };
}

/** Review a stored file record. */
export function reviewFileRecordRksvCode(record: FileRecord): RksvCodeReviewResult {
  return reviewRksvCode(toRksvCodeFacts(record));
}
