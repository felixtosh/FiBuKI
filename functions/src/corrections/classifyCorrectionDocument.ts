/**
 * Invoice Correction or Self-billed Invoice? (#564, ADR-0010 rule 2, D8)
 *
 * "Gutschrift" names both: a supplier's credit note that reduces an earlier
 * invoice, and a Self-billed Invoice (§ 11 Abs 7) a platform writes in the
 * User's name, which is revenue. The signals, strongest first:
 *
 *  1. A referenced invoice number. A document that names the invoice it
 *     corrects is a correction, whatever the sign of its figures (story 20).
 *  2. A credit-note heading with negative figures is a correction, still to be
 *     linked to its original.
 *  3. A "Gutschrift" heading with positive figures and no reference is a
 *     Self-billed Invoice.
 *
 * Where the signals disagree — a reference on positive figures, negative
 * figures with neither a heading nor a reference, a heading that can only mean
 * a correction on positive figures — the verdict still stands on the stronger
 * signal, and the File is flagged for a person to decide.
 */

export type CorrectionDocumentKind = "invoice-correction" | "self-billed-invoice";

export interface CorrectionDocumentVerdict {
  kind: CorrectionDocumentKind | null;
  /** The signals disagree; a person decides the ambiguous case (story 22). */
  signalsDisagree: boolean;
}

export interface CorrectionDocumentFacts {
  extractedSelfDesignation?: string | null;
  extractedReferencedInvoiceNumber?: string | null;
  extractedAmount?: number | null;
}

/** Headings that only ever mean a correction of an earlier invoice. */
const CORRECTION_ONLY_HEADING =
  /rechnungskorrektur|korrekturrechnung|storno|stornierung|r(ü|ue)ckerstattung|credit\s*note|creditnote|cancellation|corrective\s+invoice|refund/i;
/** "Gutschrift" alone: a correction or a Self-billed Invoice, the sign decides. */
const GUTSCHRIFT_HEADING = /gutschrift|self[-\s]?billing|selbstfakturierung/i;

export function classifyCorrectionDocument(f: CorrectionDocumentFacts): CorrectionDocumentVerdict {
  const heading = f.extractedSelfDesignation?.trim() ?? "";
  const correctionHeading = CORRECTION_ONLY_HEADING.test(heading);
  const gutschrift = !correctionHeading && GUTSCHRIFT_HEADING.test(heading);
  const referenced = !!f.extractedReferencedInvoiceNumber?.trim();
  const amount = f.extractedAmount ?? null;
  const negative = amount !== null && amount < 0;
  const positive = amount !== null && amount > 0;

  if (referenced) {
    return { kind: "invoice-correction", signalsDisagree: positive };
  }
  if (correctionHeading) {
    return { kind: "invoice-correction", signalsDisagree: positive };
  }
  if (gutschrift) {
    return negative
      ? { kind: "invoice-correction", signalsDisagree: false }
      : { kind: "self-billed-invoice", signalsDisagree: false };
  }
  if (negative) {
    // Negative figures and nothing else: read as a correction so it is never
    // booked as negative revenue, and put in front of a person.
    return { kind: "invoice-correction", signalsDisagree: true };
  }
  return { kind: null, signalsDisagree: false };
}
