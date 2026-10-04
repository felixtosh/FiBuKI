/**
 * The File facts module (#637, #638): one place decides every write of a
 * File's extracted facts.
 *
 * A pure function from the current File and a Fact Change to an outcome:
 * either the complete File update, with every derived field recomputed, plus
 * the follow-ups that must run after it, or a refusal. It reads nothing and
 * writes nothing; `applyFactChange.ts` is the one applier that does both.
 *
 * A Fact Change names its origin, and the rules key on it. Today the origins
 * are the two Hand Correction doors: the File detail panel (`ui-correction`)
 * and the MCP correction tool (`mcp-correction`). They take one contract. The
 * one rule that differs is what counts as corrected: the panel posts the whole
 * record on every save, so only a value that differs from the stored one is a
 * correction; an MCP caller names the fields it means, so what it passes is
 * what it corrects. Extraction, the identity sweep, Not Invoice and generated
 * invoices join as origins of their own (#639, #640); until then the
 * re-extraction check below is the module's whole say over Extraction.
 *
 * Derived here, so no caller can forget one: the Document Type, the 11 % rate
 * review, the RKSV review, the direction review, the Line Item reconciliation,
 * the repair flags (retired field by field), the tip bound, and the Due Date
 * and Debit Date.
 */

import { Timestamp } from "firebase-admin/firestore";
import type { ExtractedLineItem, ExtractedRateGroup } from "../types/extraction";
import { reconcileLineItemsWithDocumentTotal } from "../extraction/lineItemReconciliation";
import { classifyFileRecord, documentTypeFields, type FileRecord } from "../documents/adapter";
import { reviewFileRecordVatRates, vatRateReviewFields } from "../documents/vatRateReview";
import { reviewFileRecordRksvCode, rksvCodeReviewFields } from "../documents/rksvCodeReview";
import { retireRepairAmbiguity } from "../documents/repairReview";
import {
  directionReviewFields,
  reviewDirection,
  toDirectionFacts,
  type DirectionTransactionFacts,
} from "../documents/directionReview";
import { dueDateFromAdditionalFields } from "../matching/dueDate";
import { debitDateFromAdditionalFields } from "../matching/debitDate";
import { toDateSafe } from "../utils/toDateSafe";
import { checkTipBound } from "./tipBound";
import {
  DESCRIPTIVE_FIELDS,
  ExtractionCorrectionError,
  buildExtractionCorrection,
  normalizeAdditionalFields,
  normalizeDetailText,
  selectMovedCorrections,
  type ExtractedDetails,
  type FileExtractionCorrection,
} from "./handCorrection";
import { buildCorrectionProvenance, correctedFieldsOf, CORRECTABLE_FIELDS } from "./provenance";

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/** The current File, and what the module needs to know about it besides its record. */
export interface CurrentFile {
  record: Record<string, unknown>;
  /** The Transactions the File is connected to, which the direction review reads. */
  linkedTransactions: DirectionTransactionFacts[];
}

/** Where a Hand Correction came from. The two doors take one contract. */
export type HandCorrectionOrigin = "ui-correction" | "mcp-correction";

/** A User's change to a File's extracted facts, through the panel or the MCP tool. */
export interface HandCorrectionChange {
  origin: HandCorrectionOrigin;
  /** The figures. Omitted is not null: an absent key is left alone, null clears it. */
  correction?: FileExtractionCorrection;
  /** The descriptive fields, under the same rule. */
  details?: ExtractedDetails;
  /**
   * The tip in this correction is not printed on the invoice (#310), so the
   * document total does not bound it (#554). A property of this change, not a
   * value the record keeps per field: what it decided is stored as
   * `extractedTipBound`.
   */
  tipNotPrinted?: boolean;
  /** When the change is made; stamps the Hand Correction record and `updatedAt`. */
  at?: Timestamp;
}

export type FactChange = HandCorrectionChange;

/**
 * What the applier does after the write.
 *
 * - `sync-documentation-state`: the Document Type moved, so the stored
 *   Documentation State of each connected Transaction is re-derived (#104).
 * - `rescore-suggestions`: a Hand Correction moved a fact the scorer reads, so
 *   the File's suggestions are re-scored in the matcher's suggestions-only
 *   mode. Nothing is connected or disconnected (#637 user story 13).
 */
export type FollowUp =
  | { kind: "sync-documentation-state"; transactionIds: string[] }
  | { kind: "rescore-suggestions" };

export interface FactRefusal {
  refused: true;
  /** `INVALID`: a value the module cannot store. `HAND_CORRECTED`: see `reExtractionRefusal`. */
  code: "INVALID" | "HAND_CORRECTED";
  message: string;
  /** The recorded fields a re-extraction would discard, on `HAND_CORRECTED`. */
  fields?: string[];
}

export interface FactUpdate {
  refused: false;
  /** The complete File update. Empty when the change moved nothing. */
  update: Record<string, unknown>;
  followUps: FollowUp[];
  /** The fields this change recorded in the Hand Correction record. */
  changed: string[];
  /** The stored names of the descriptive fields whose value this change moved. */
  movedDetails: string[];
}

export type FactOutcome = FactUpdate | FactRefusal;

// ---------------------------------------------------------------------------
// The re-extraction check
// ---------------------------------------------------------------------------

/**
 * Whether a re-extraction of this File is refused (#184).
 *
 * A File carrying a Hand Correction is refused as a whole, never merged field
 * by field, so a corrected amount never sits beside a freshly read VAT that
 * contradicts it. `overwriteCorrections` is the forced re-extraction: it
 * overwrites, deliberately, and is decided per File. The Hand Correction
 * record is not cleared by it: a person did once rule on this document.
 */
export function reExtractionRefusal(
  record: Record<string, unknown>,
  options: { overwriteCorrections?: boolean }
): FactRefusal | null {
  if (options.overwriteCorrections === true) return null;
  const fields = correctedFieldsOf(record);
  if (fields.length === 0) return null;
  return {
    refused: true,
    code: "HAND_CORRECTED",
    fields,
    message:
      `File carries hand corrections a re-extraction would discard (${fields.join(", ")}). ` +
      "Pass overwriteCorrections to re-extract it anyway.",
  };
}

// ---------------------------------------------------------------------------
// A Hand Correction
// ---------------------------------------------------------------------------

/**
 * The stored fields a Hand Correction re-scores on: the ones the scorer reads,
 * and the IBAN and VAT ID that identify the counterparty (Stefan, 2026-10-04).
 */
const SCORED_FIELDS = [
  "extractedAmount",
  "extractedDate",
  "extractedDueDate",
  "extractedDebitDate",
  "extractedPartner",
  "extractedIban",
  "extractedVatId",
] as const;

export function decideFactChange(current: CurrentFile, change: FactChange): FactOutcome {
  try {
    return decideHandCorrection(current, change);
  } catch (error) {
    if (error instanceof ExtractionCorrectionError) {
      return { refused: true, code: "INVALID", message: error.message };
    }
    throw error;
  }
}

function decideHandCorrection(current: CurrentFile, change: HandCorrectionChange): FactOutcome {
  const { record } = current;
  const at = change.at ?? Timestamp.now();

  if (change.tipNotPrinted !== undefined && typeof change.tipNotPrinted !== "boolean") {
    throw new ExtractionCorrectionError("tipNotPrinted must be a boolean");
  }

  const proposed = onlyCorrectableKeys(change.correction ?? {});
  const details = onlyDescriptiveKeys(change.details ?? {});

  if (
    change.origin === "mcp-correction" &&
    Object.keys(proposed).length === 0 &&
    Object.keys(details).length === 0
  ) {
    throw new ExtractionCorrectionError(
      "Nothing to correct — pass at least one of " +
        [...CORRECTABLE_FIELDS, ...Object.keys(DESCRIPTIVE_FIELDS)].join(", ")
    );
  }

  // What counts as corrected is the one rule the doors differ on (see top).
  const moved =
    change.origin === "ui-correction" ? selectMovedCorrections(proposed, record) : proposed;

  const update: Record<string, unknown> = {};
  const changed: string[] = [];

  if (Object.keys(moved).length > 0) {
    const built = buildExtractionCorrection(moved, record, at);
    Object.assign(update, built.updates);
    changed.push(...built.changed);

    // #310. Only a correction that sets the tip is measured: a File carrying
    // an oversized tip from before the guard must stay repairable through every
    // other field.
    if (moved.tipAmount !== undefined) {
      const corrected = { ...record, ...update };
      update.extractedTipBound = checkTipBound({
        tip: typeof corrected.extractedTipAmount === "number" ? corrected.extractedTipAmount : null,
        documentTotal: typeof corrected.extractedAmount === "number" ? corrected.extractedAmount : null,
        notPrinted: change.tipNotPrinted === true,
      });
    }
  }

  // #203: a form save with the itemisation editor open that moved no figure
  // re-derives the reconciliation flag against the stored record, printed
  // block still standing (a save that corrected nothing says nothing against
  // it), and writes only when the answer differs. A save that moved a figure
  // re-derived it inside the builder above.
  if (proposed.lineItems !== undefined && update.lineItemsUnreconciled === undefined) {
    const items = record.extractedLineItems as ExtractedLineItem[] | null | undefined;
    const reconciled = reconcileLineItemsWithDocumentTotal(
      Array.isArray(items) ? items : [],
      (record.extractedAmount as number | null | undefined) ?? null,
      (record.extractedRateGroups as ExtractedRateGroup[] | null | undefined) ?? null,
      (record.extractedVatPercent as number | null | undefined) ?? null
    );
    if (reconciled.unreconciled !== Boolean(record.lineItemsUnreconciled)) {
      update.lineItemsUnreconciled = reconciled.unreconciled;
      update.lineItemsUnreconciledRates =
        reconciled.unreconciledRates.length > 0 ? reconciled.unreconciledRates : null;
    }
  }

  // The descriptive fields are written as given: the panel shows them as typed.
  const movedDetails: string[] = [];
  for (const [key, storedField] of Object.entries(DESCRIPTIVE_FIELDS)) {
    const value = details[key as keyof ExtractedDetails];
    if (value === undefined) continue;
    update[storedField] =
      key === "additionalFields"
        ? normalizeAdditionalFields(value, record.extractedAdditionalFields)
        : normalizeDetailText(value, key);
    const same =
      key === "additionalFields"
        ? sameRows(update[storedField], record[storedField])
        : sameStored(update[storedField], record[storedField]);
    if (!same) movedDetails.push(storedField);
  }

  // The Due Date and Debit Date are read off the rows, against the issue date
  // the File is left with (#236, #135, #136). Both inputs can move here.
  const rowsSent = details.additionalFields !== undefined;
  const after = { ...record, ...update };
  if (rowsSent || changed.includes("date")) {
    const issueDate = toDateSafe(after.extractedDate);
    update.extractedDueDate = asStoredDate(
      dueDateFromAdditionalFields(after.extractedAdditionalFields, issueDate)
    );
    update.extractedDebitDate = asStoredDate(
      debitDateFromAdditionalFields(after.extractedAdditionalFields, issueDate)
    );

    // A person who changed the date a row states set that date by hand, so
    // the Hand Correction record names it and a later Extraction refuses the
    // File rather than read the old date back (#638). A date the issue-date
    // guard alone moved was not set by anyone. Compared without the guard,
    // on the rows themselves.
    if (rowsSent) {
      const handSet: string[] = [];
      if (rowDateMoved(dueDateFromAdditionalFields, record, after)) handSet.push("dueDate");
      if (rowDateMoved(debitDateFromAdditionalFields, record, after)) handSet.push("debitDate");
      if (handSet.length > 0) {
        Object.assign(update, buildCorrectionProvenance({ ...record, ...update }, handSet, at));
        changed.push(...handSet);
      }
    }
  }

  const somethingMoved = changed.length > 0 || movedDetails.length > 0;

  if (somethingMoved) {
    const corrected = { ...record, ...update } as FileRecord;
    Object.assign(update, documentTypeFields(classifyFileRecord(corrected)));
    Object.assign(update, vatRateReviewFields(reviewFileRecordVatRates(corrected)));
    // #166: a VAT-bearing correction clears the printed block the RKSV Code
    // disagreed with, so the flag goes; any other correction leaves it.
    Object.assign(update, rksvCodeReviewFields(reviewFileRecordRksvCode(corrected)));
    // #233: setting the direction by hand clears the flag that said it was wrong.
    Object.assign(
      update,
      directionReviewFields(reviewDirection(toDirectionFacts(corrected, current.linkedTransactions)))
    );
    // #301: the repair flag is retired per field, never recomputed: a value a
    // person typed replaces the guess the flag warned about.
    Object.assign(
      update,
      retireRepairAmbiguity(record, [...figureStoredFields(changed), ...movedDetails])
    );
  }

  if (Object.keys(update).length > 0) {
    update.updatedAt = at;
  }

  return {
    refused: false,
    update,
    followUps: followUpsOf(record, update, somethingMoved),
    changed,
    movedDetails,
  };
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

function followUpsOf(
  record: Record<string, unknown>,
  update: Record<string, unknown>,
  somethingMoved: boolean
): FollowUp[] {
  const followUps: FollowUp[] = [];

  const transactionIds = Array.isArray(record.transactionIds)
    ? (record.transactionIds as string[])
    : [];
  if (
    update.documentType !== undefined &&
    update.documentType !== record.documentType &&
    transactionIds.length > 0
  ) {
    followUps.push({ kind: "sync-documentation-state", transactionIds });
  }

  if (
    somethingMoved &&
    SCORED_FIELDS.some((field) => field in update && !sameStored(update[field], record[field]))
  ) {
    followUps.push({ kind: "rescore-suggestions" });
  }

  return followUps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Where each correctable field is stored, for the repair flag's per-field retirement. */
const FIGURE_STORED_FIELD: Record<string, string> = {
  amount: "extractedAmount",
  vatAmount: "extractedVatAmount",
  vatPercent: "extractedVatPercent",
  date: "extractedDate",
  lineItems: "extractedLineItems",
  invoiceDirection: "invoiceDirection",
  tipAmount: "extractedTipAmount",
};

function figureStoredFields(changed: string[]): string[] {
  return changed.map((field) => FIGURE_STORED_FIELD[field]).filter(Boolean);
}

/**
 * Take only the keys the correction vocabulary defines, so an extra key posted
 * by a stale client cannot reach the update. Values are left as they came:
 * validating them is the builder's job, and a value it refuses must produce
 * its refusal rather than be quietly dropped here.
 */
function onlyCorrectableKeys(correction: FileExtractionCorrection): FileExtractionCorrection {
  const clean: Record<string, unknown> = {};
  for (const key of CORRECTABLE_FIELDS) {
    const value = (correction as Record<string, unknown>)[key];
    if (value !== undefined) clean[key] = value;
  }
  return clean as FileExtractionCorrection;
}

function onlyDescriptiveKeys(details: ExtractedDetails): ExtractedDetails {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(DESCRIPTIVE_FIELDS)) {
    const value = (details as Record<string, unknown>)[key];
    if (value !== undefined) clean[key] = value;
  }
  return clean as ExtractedDetails;
}

function asStoredDate(date: Date | null): Timestamp | null {
  return date ? Timestamp.fromDate(date) : null;
}

/** Did the date the rows state move, the issue-date guard aside? */
function rowDateMoved(
  read: (fields: unknown) => Date | null,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): boolean {
  const was = read(before.extractedAdditionalFields)?.getTime() ?? null;
  const now = read(after.extractedAdditionalFields)?.getTime() ?? null;
  return was !== now;
}

/**
 * Two stored values the same? Dates by instant, arrays and objects by value,
 * absent and null alike: the record holds no value either way.
 */
function sameStored(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  const dateA = asInstant(a);
  const dateB = asInstant(b);
  if (dateA !== null || dateB !== null) return dateA === dateB;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return a === b;
}

/**
 * Two lists of additional-field rows the same? By what each row says (key,
 * label, value), in order. `rawValue` is the extractor's transcript and a row
 * stored before it existed has none, so it is not compared: an untouched save
 * must not read as a moved row.
 */
function sameRows(a: unknown, b: unknown): boolean {
  const said = (rows: unknown) =>
    (Array.isArray(rows) ? rows : []).map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return [row.key ?? null, row.label ?? null, row.value ?? null];
    });
  return JSON.stringify(said(a)) === JSON.stringify(said(b));
}

function asInstant(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  const candidate = value as { toDate?: () => Date } | null;
  if (candidate && typeof candidate === "object" && typeof candidate.toDate === "function") {
    return toDateSafe(value)?.getTime() ?? null;
  }
  return null;
}
