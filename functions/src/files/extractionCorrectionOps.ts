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
import { buildCorrectionProvenance, CORRECTABLE_FIELDS } from "./extractionProvenanceOps";

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
  /**
   * Which way the document points (#233): `incoming` is a purchase, `outgoing`
   * a sale, `unknown` an honest absence. Until this existed the only way to
   * change it was to edit the user's identity data and hope the backfill
   * picked the file up.
   */
  invoiceDirection?: InvoiceDirection | null;
}

/** Mirrors `InvoiceDirection` on the file record. */
export type InvoiceDirection = "incoming" | "outgoing" | "unknown";

const INVOICE_DIRECTIONS: InvoiceDirection[] = ["incoming", "outgoing", "unknown"];

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

  if (fields.invoiceDirection !== undefined) {
    // Null clears it to `unknown` rather than removing the field: the review
    // rule reads an absent direction and an explicit unknown identically, and
    // one stored shape is easier to query than two.
    if (fields.invoiceDirection === null) {
      updates.invoiceDirection = "unknown";
    } else {
      if (!INVOICE_DIRECTIONS.includes(fields.invoiceDirection)) {
        throw new ExtractionCorrectionError(
          `invoiceDirection must be one of ${INVOICE_DIRECTIONS.join(", ")}`
        );
      }
      updates.invoiceDirection = fields.invoiceDirection;
    }
    changed.push("invoiceDirection");
  }

  if (changed.length === 0) {
    throw new ExtractionCorrectionError(
      "Nothing to correct — pass at least one of amount, vatAmount, vatPercent, date, " +
        "lineItems, invoiceDirection"
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

/** Where each correctable field is stored on the file record. */
const STORED_FIELD: Record<(typeof CORRECTABLE_FIELDS)[number], string> = {
  amount: "extractedAmount",
  vatAmount: "extractedVatAmount",
  vatPercent: "extractedVatPercent",
  date: "extractedDate",
  lineItems: "extractedLineItems",
  // Not an extracted figure and not stored under `extracted*`: the direction is
  // a read of the document, kept on the record itself (#233).
  invoiceDirection: "invoiceDirection",
};

/**
 * Reduce a proposed correction to the fields that actually moved (#149).
 *
 * The MCP tool names the fields it means, so there "present" is "corrected".
 * The file detail panel sends the whole extracted record on every save, so
 * there "present" says nothing — passing that straight to
 * `buildExtractionCorrection` would stamp all five fields the first time
 * someone opens the panel and saves without typing, and a file stamped that
 * way is a file `retry_file_extraction` refuses to touch forever.
 *
 * So the comparison is here, beside the builder that stamps, rather than in
 * the client: one copy of "did this field really change", and it is the copy
 * that owns cents, a Timestamp date and a line-item array.
 *
 * **A value it cannot compare counts as moved.** Dropping an unparseable date
 * as "unchanged" would turn the builder's refusal into a silent no-op; keeping
 * it lets the refusal happen where the message is.
 */
export function selectMovedCorrections(
  fields: FileExtractionCorrection,
  previous: Record<string, unknown>
): FileExtractionCorrection {
  const moved: Record<string, unknown> = {};

  for (const field of CORRECTABLE_FIELDS) {
    const proposed = (fields as Record<string, unknown>)[field];
    if (proposed === undefined) continue;
    if (!matchesStored(field, proposed, previous[STORED_FIELD[field]])) {
      moved[field] = proposed;
    }
  }

  return moved as FileExtractionCorrection;
}

function matchesStored(
  field: (typeof CORRECTABLE_FIELDS)[number],
  proposed: unknown,
  stored: unknown
): boolean {
  if (field === "date") return datesMatch(proposed, stored);
  if (field === "lineItems") return lineItemsMatch(proposed, stored);
  if (field === "invoiceDirection") return directionsMatch(proposed, stored);
  return numbersMatch(proposed, stored, field !== "vatPercent");
}

/**
 * The direction has three values and two spellings of "not established": the
 * builder stores `unknown` where a caller passed null, and records written
 * before #233 have no field at all. All three read as the same answer here, so
 * re-sending `unknown` for a document nobody has placed is not a correction.
 */
function directionsMatch(proposed: unknown, stored: unknown): boolean {
  const settled = (value: unknown) => (isEmpty(value) || value === "unknown" ? "unknown" : value);
  return settled(proposed) === settled(stored);
}

/** Absent and null are the same answer: the record holds no value. */
function isEmpty(value: unknown): boolean {
  return value === null || value === undefined;
}

function numbersMatch(proposed: unknown, stored: unknown, asCents: boolean): boolean {
  if (isEmpty(proposed)) return isEmpty(stored);
  if (typeof proposed !== "number" || !Number.isFinite(proposed)) return false;
  if (typeof stored !== "number" || !Number.isFinite(stored)) return false;
  return asCents ? Math.round(proposed) === Math.round(stored) : proposed === stored;
}

/**
 * A date is compared by the day it names. The stored value is a Timestamp and
 * the proposed one a `YYYY-MM-DD` string, so anything else would compare a
 * wrapper object against text and call every save a correction.
 *
 * **Both time frames count as the same day.** `extractionCore` writes the
 * stored Timestamp with `new Date(y, m - 1, d)`, which is midnight *local*.
 * Cloud Functions run in UTC so the two agree there, but a self-host container
 * running in Europe/Vienna stores 23:00 UTC of the day before, and reading that
 * back in UTC only would report the date as moved on every save of a file
 * nobody edited — stamping a correction that was never made. Where the two
 * readings straddle midnight the ambiguity is unresolvable, so it is resolved
 * towards "unchanged": a phantom correction is the expensive answer, since it
 * is what a later re-extraction refuses on.
 */
function datesMatch(proposed: unknown, stored: unknown): boolean {
  if (isEmpty(proposed)) return isEmpty(stored);
  if (typeof proposed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(proposed)) return false;

  const storedDate = toDate(stored);
  if (!storedDate) return false;

  return storedDate.toISOString().slice(0, 10) === proposed || localDay(storedDate) === proposed;
}

/** The day a Date names in the host's own time zone, as `YYYY-MM-DD`. */
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const candidate = value as { toDate?: () => Date; _seconds?: number } | null;
  if (candidate && typeof candidate.toDate === "function") {
    const date = candidate.toDate();
    return date instanceof Date && !isNaN(date.getTime()) ? date : null;
  }
  if (candidate && typeof candidate._seconds === "number") {
    return new Date(candidate._seconds * 1000);
  }
  return null;
}

/**
 * Itemisations are compared position by position: the order is what the
 * document prints, so moving two rows is a correction even when the totals are
 * untouched. Both sides go through the same normaliser, so a stored row that
 * predates a shape change does not read as a change on every save.
 */
function lineItemsMatch(proposed: unknown, stored: unknown): boolean {
  const storedItems = Array.isArray(stored) ? stored : [];
  if (isEmpty(proposed)) return storedItems.length === 0;
  if (!Array.isArray(proposed)) return false;

  let left: ExtractedLineItem[];
  let right: ExtractedLineItem[];
  try {
    left = normalizeLineItems(proposed, "lineItems");
    right = normalizeLineItems(storedItems, "lineItems");
  } catch {
    // An item the builder will refuse, or a stored row too broken to normalise.
    // Either way this is not a match the caller can rely on.
    return false;
  }

  if (left.length !== right.length) return false;

  return left.every((item, index) => {
    const other = right[index];
    return (
      item.description === other.description &&
      item.quantity === other.quantity &&
      item.unitPrice === other.unitPrice &&
      item.vatPercent === other.vatPercent &&
      item.vatAmount === other.vatAmount &&
      item.amount === other.amount
    );
  });
}
