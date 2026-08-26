/**
 * Human corrections to a file's extracted record (fork #147).
 *
 * `retry_file_extraction` re-rolls the model, which converges only when the
 * answer is on the page. It cannot converge when the right value depends on
 * judgement the document does not state unambiguously: a Schlussrechnung
 * printing both the full amount and the part already invoiced, VAT that is
 * correctly extracted and legitimately not claimable, a one-cent OCR slip
 * inside the reconciliation tolerance. Those need a person, and until this
 * existed a person meant retyping the value in the UI.
 *
 * The builder is pure so the rules below are testable without a database.
 */

import { Timestamp } from "firebase-admin/firestore";
import { ExtractedLineItem } from "../types/extraction";
import { buildCorrectionProvenance } from "./extractionProvenanceOps";

/**
 * A correction. **Omitted is not null**: a key absent here is left untouched,
 * a key set to `null` clears the stored value. Passing only `vatPercent` must
 * never wipe the amount.
 */
export interface FileExtractionCorrection {
  /** Document total in cents. Negative is legal — a credit note. */
  amount?: number | null;
  /** Document VAT in cents. */
  vatAmount?: number | null;
  /** Document VAT rate, 0-100. Zero is a real correction, not "unset". */
  vatPercent?: number | null;
  /** Document date as `YYYY-MM-DD`. */
  date?: string | null;
  /** The itemisation, replaced wholesale. */
  lineItems?: ExtractedLineItem[] | null;
}

export class ExtractionCorrectionError extends Error {}

const VAT_BEARING: Array<keyof FileExtractionCorrection> = [
  "amount",
  "vatAmount",
  "vatPercent",
  "lineItems",
];

function cents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ExtractionCorrectionError(`${field} must be a finite number of cents`);
  }
  return Math.round(value);
}

function normalizeLineItems(lineItems: unknown, field: string): ExtractedLineItem[] {
  if (!Array.isArray(lineItems)) {
    throw new ExtractionCorrectionError(`${field} must be an array`);
  }
  return lineItems.map((raw, index) => {
    const item = (raw ?? {}) as Partial<ExtractedLineItem>;
    const amount = cents(item.amount, `${field}[${index}].amount`);
    const vatPercent =
      typeof item.vatPercent === "number" &&
      Number.isFinite(item.vatPercent) &&
      item.vatPercent >= 0 &&
      item.vatPercent <= 100
        ? item.vatPercent
        : null;
    const vatAmount =
      typeof item.vatAmount === "number" && Number.isFinite(item.vatAmount)
        ? Math.round(item.vatAmount)
        : 0;
    return {
      description:
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : `Item ${index + 1}`,
      quantity:
        typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : null,
      unitPrice:
        typeof item.unitPrice === "number" && Number.isFinite(item.unitPrice)
          ? Math.round(item.unitPrice)
          : null,
      vatPercent,
      vatAmount,
      amount,
    };
  });
}

function parseIsoDate(value: unknown): Timestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ExtractionCorrectionError("date must be an ISO date string, YYYY-MM-DD");
  }
  const [y, m, d] = value.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new ExtractionCorrectionError(`date ${value} is not a real calendar date`);
  }
  return Timestamp.fromDate(date);
}

export interface BuiltCorrection {
  updates: Record<string, unknown>;
  /** Which fields the caller actually asked to change, for the log and the reply. */
  changed: string[];
}

/**
 * Turn a correction into the Firestore update, or throw.
 *
 * Two rules that are easy to get wrong and expensive when they are:
 *
 * **The corrected total is never re-derived from the line items.** The case
 * that motivated this is a Schlussrechnung whose amount is 3180.00 while its
 * items describe the full 6360.00 scope — consolidating the amount back out of
 * the items would silently undo the correction the person just made.
 *
 * **A correction makes the person the authority**, so the artefacts that would
 * outrank them are cleared: the reconciliation flags (which otherwise keep a
 * repaired file in the review bucket forever), the printed rate-group block
 * (which VAT derivation prefers over everything else, so a surviving block
 * would quietly ignore a corrected rate), and the fork #137 downgrade markers.
 * That happens for any VAT-bearing correction; a date-only fix leaves them be,
 * since it says nothing about the VAT.
 *
 * **Every correction stamps its own provenance** (#184), merged onto whatever
 * `previous` already carries. That is here rather than at the call site so a
 * correction cannot be applied by any surface without saying a human made it —
 * which is what a re-extraction later refuses on, and what a sweep reads to
 * build its exclusion list.
 */
export function buildExtractionCorrection(
  fields: FileExtractionCorrection,
  previous: Record<string, unknown> = {}
): BuiltCorrection {
  const updates: Record<string, unknown> = {};
  const changed: string[] = [];

  if (fields.amount !== undefined) {
    updates.extractedAmount = fields.amount === null ? null : cents(fields.amount, "amount");
    changed.push("amount");
  }

  if (fields.vatAmount !== undefined) {
    updates.extractedVatAmount = fields.vatAmount === null ? null : cents(fields.vatAmount, "vatAmount");
    changed.push("vatAmount");
  }

  if (fields.vatPercent !== undefined) {
    if (fields.vatPercent === null) {
      updates.extractedVatPercent = null;
    } else {
      if (
        typeof fields.vatPercent !== "number" ||
        !Number.isFinite(fields.vatPercent) ||
        fields.vatPercent < 0 ||
        fields.vatPercent > 100
      ) {
        throw new ExtractionCorrectionError("vatPercent must be a number between 0 and 100");
      }
      updates.extractedVatPercent = fields.vatPercent;
    }
    changed.push("vatPercent");
  }

  if (fields.date !== undefined) {
    updates.extractedDate = fields.date === null ? null : parseIsoDate(fields.date);
    changed.push("date");
  }

  if (fields.lineItems !== undefined) {
    updates.extractedLineItems =
      fields.lineItems === null ? null : normalizeLineItems(fields.lineItems, "lineItems");
    changed.push("lineItems");
  }

  if (changed.length === 0) {
    throw new ExtractionCorrectionError(
      "Nothing to correct — pass at least one of amount, vatAmount, vatPercent, date, lineItems"
    );
  }

  if (VAT_BEARING.some((field) => fields[field] !== undefined)) {
    updates.lineItemsUnreconciled = false;
    updates.lineItemsUnreconciledRates = null;
    updates.extractedRateGroups = null;
    updates.vatSourceDowngraded = false;
    updates.vatFieldsPreserved = false;
  }

  Object.assign(updates, buildCorrectionProvenance(previous, changed));

  updates.updatedAt = Timestamp.now();

  return { updates, changed };
}
