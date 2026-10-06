/**
 * Marking a File Not Invoice, as the File facts module writes it (#640, #710).
 *
 * A person rules that the document is not an invoice. There is nothing to
 * extract from it, so its facts are cleared and the matching derived from
 * them starts over.
 *
 * - The facts cleared are the ones an Extraction's own not-invoice reading
 *   clears (`notInvoiceClearedFacts`), so both paths leave the same File with
 *   the same facts. The tip, its bound, the Due Date, the Debit Date and the
 *   instalments are among them (Stefan, 2026-10-05; #615).
 * - The derived fields (the Document Type, the direction review and the other
 *   review flags) are not set here: the module computes them on the File as
 *   this leaves it, with the derivation an Extraction uses (#710).
 * - The Hand Correction record is cleared for the figures this wipes, in the
 *   same write. Every figure it can name is wiped here, so a record that
 *   named only those is gone, and un-marking the File later re-extracts it
 *   without a refusal: the corrected values no longer exist to protect.
 *
 * A Partner the person chose by hand survives: the classification being wrong
 * does not make that choice wrong.
 */

import { RECORDED_FIELDS } from "./provenance";
import { notInvoiceClearedFacts } from "./extractionReading";

/** The `isNotInvoice` transition the module returns for a File record, before its derived fields. */
export function notInvoiceFields(
  record: Record<string, unknown>,
  reason: string | undefined
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    isNotInvoice: true,
    notInvoiceReason: reason || "Marked by user",
    classificationComplete: true,
    // Every fact, as an Extraction's not-invoice reading clears them (#710).
    ...notInvoiceClearedFacts(),
    // What the last Extraction run left besides the facts: a person's ruling
    // read nothing, so nothing of a reading stays.
    extractedText: null,
    extractedFields: null,
    extractionConfidence: null,
    invoiceDirection: null,
    // Mark extraction as complete (nothing to extract for non-invoices)
    extractionComplete: true,
    // Reset downstream matching
    partnerMatchComplete: false,
    partnerSuggestions: [],
    transactionMatchComplete: false,
    transactionSuggestions: [],
  };

  if (record.partnerMatchedBy !== "manual") {
    update.partnerId = null;
    update.partnerType = null;
    update.partnerMatchedBy = null;
    update.partnerMatchConfidence = null;
  }

  Object.assign(update, clearedRecordFor(record, RECORDED_FIELDS));

  return update;
}

/**
 * The Hand Correction record without the stamps of `wiped`, or nothing when
 * the File carries no record. A stamp the module does not know (a field
 * renamed since) is kept: it still says a person touched something, and only
 * the figures this write wipes lose their stamp.
 */
function clearedRecordFor(
  record: Record<string, unknown>,
  wiped: readonly string[]
): Record<string, unknown> {
  const raw = record.extractionCorrectedFields;
  const hasMap = raw !== null && raw !== undefined;
  const hasAt = record.extractionCorrectedAt !== null && record.extractionCorrectedAt !== undefined;
  if (!hasMap && !hasAt) return {};

  const stamps =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kept = Object.fromEntries(Object.entries(stamps).filter(([field]) => !wiped.includes(field)));

  if (Object.keys(kept).length === 0) {
    return { extractionCorrectedFields: null, extractionCorrectedAt: null };
  }
  return { extractionCorrectedFields: kept, extractionCorrectedAt: newest(Object.values(kept)) };
}

/** The newest of the stamps, by instant; a stamp that is no date reads as the oldest. */
function newest(stamps: unknown[]): unknown {
  const instant = (value: unknown) => {
    const candidate = value as { toMillis?: () => number; getTime?: () => number } | null;
    if (candidate && typeof candidate.toMillis === "function") return candidate.toMillis();
    if (candidate && typeof candidate.getTime === "function") return candidate.getTime();
    return -Infinity;
  };
  return stamps.reduce((a, b) => (instant(b) > instant(a) ? b : a));
}
