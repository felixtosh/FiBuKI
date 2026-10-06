/**
 * The File facts module (#637, #638): one place decides every write of a
 * File's extracted facts.
 *
 * A pure function from the current File and a Fact Change to an outcome:
 * either the complete File update, with every derived field recomputed, plus
 * the follow-ups that must run after it, or a refusal. It reads nothing and
 * writes nothing; `applyFactChange.ts` is the one applier that does both.
 *
 * A Fact Change names its origin, and the rules key on it. The origins are
 * the two Hand Correction doors, the File detail panel (`ui-correction`) and
 * the MCP correction tool (`mcp-correction`), and Extraction (`extraction`,
 * normal or forced, #639). The two doors take one contract. The one rule that
 * differs is what counts as corrected: the panel posts the whole record on
 * every save, so only a value that differs from the stored one is a
 * correction; an MCP caller names the fields it means, so what it passes is
 * what it corrects. An Extraction hands over its reading
 * (`extractionReading.ts`); on a File with a Hand Correction it is refused as
 * a whole unless forced. The other writers are origins of their own (#640):
 * marking a File Not Invoice (`not-invoice`), the identity sweep
 * (`identity-sweep`), a generated invoice (`generated-invoice`) and the
 * entity-name backfill (`entity-name-backfill`).
 *
 * Most writers go through the one applier (`applyFactChange.ts`). Two take
 * the module's decision and write it in a batch of their own, because the
 * applier's read-then-write does not fit them: the identity sweep writes up
 * to 500 Files per batch and attributes a refused write to its File (#158),
 * and a generated invoice's File is written in the same batch or transaction
 * as its invoice, often before the File exists.
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
import { repairReviewFields, retireRepairAmbiguity, reviewRepair } from "../documents/repairReview";
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
import { extractionFields, type ExtractionReading } from "./extractionReading";
import { notInvoiceFields } from "./notInvoice";
import { sweepFields, type SweepDerivation } from "./identitySweep";
import { draftInvoiceFacts, issuedInvoiceFacts } from "./generatedInvoice";
import { decodedEntityNameFields } from "./entityNames";
import type { Invoice } from "../invoicing/types";

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

/** One Extraction's reading of the document, handed over to be written (#639). */
export interface ExtractionChange {
  origin: "extraction";
  /**
   * The forced re-extraction (`overwriteCorrections`): it overwrites a Hand
   * Correction instead of being refused. The record of the correction stays.
   */
  forced?: boolean;
  reading: ExtractionReading;
  /** When the reading is written; stamps `lastFactChange` and `updatedAt`. */
  at?: Timestamp;
}

/**
 * A person rules the File is not an invoice (#640): its facts are cleared,
 * and the Hand Correction record with them (Stefan, 2026-10-05).
 */
export interface NotInvoiceChange {
  origin: "not-invoice";
  reason?: string;
  at?: Timestamp;
}

/**
 * The identity sweep re-derived the File's direction and counterparty from
 * its entities and the User's identity now (#640). A hand-corrected direction
 * is kept.
 */
export interface IdentitySweepChange {
  origin: "identity-sweep";
  derived: SweepDerivation;
  at?: Timestamp;
}

/**
 * FiBuKI generated the document (#640): the File's facts are the invoice's.
 * `invoice` is null for a draft's stub, which carries only its direction.
 */
export interface GeneratedInvoiceChange {
  origin: "generated-invoice";
  invoice: Invoice | null;
  at?: Timestamp;
}

/** The one-off backfill that decodes HTML references in stored names (#299, #640). */
export interface EntityNameBackfillChange {
  origin: "entity-name-backfill";
  at?: Timestamp;
}

export type FactChange =
  | HandCorrectionChange
  | ExtractionChange
  | NotInvoiceChange
  | IdentitySweepChange
  | GeneratedInvoiceChange
  | EntityNameBackfillChange;

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
  /**
   * The identity sweep only: the direction a Hand Correction kept, when the
   * sweep derived a different one. The sweep records it in its run report.
   */
  keptDirection?: { stored: string; derived: string } | null;
}

export type FactOutcome = FactUpdate | FactRefusal;

// ---------------------------------------------------------------------------
// Which write was a Hand Correction
// ---------------------------------------------------------------------------

/**
 * Stamped on every update the module returns: which origin wrote the File's
 * facts last, and when. A trigger sees only the File before and after a
 * write, so this is how it tells a Hand Correction from any other write.
 */
export const LAST_FACT_CHANGE_FIELD = "lastFactChange";

const HAND_CORRECTION_ORIGINS: readonly string[] = ["ui-correction", "mcp-correction"];

/**
 * Was the write that turned `before` into `after` a Hand Correction? A
 * correction connects nothing, so a trigger that would connect a File after
 * this write (the Receipt Link follow, #571) only suggests instead (Stefan,
 * 2026-10-04).
 */
export function isHandCorrectionWrite(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): boolean {
  const stampOf = (record: Record<string, unknown> | undefined) =>
    (record?.[LAST_FACT_CHANGE_FIELD] ?? null) as { origin?: unknown; at?: unknown } | null;
  const now = stampOf(after);
  if (!now || !HAND_CORRECTION_ORIGINS.includes(now.origin as string)) return false;
  const was = stampOf(before);
  return !was || was.origin !== now.origin || !sameStored(was.at, now.at);
}

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
  if (change.origin === "extraction") return decideExtraction(current, change);
  if (change.origin === "not-invoice") return decideNotInvoice(current, change);
  if (change.origin === "identity-sweep") return decideIdentitySweep(current, change);
  if (change.origin === "generated-invoice") return decideGeneratedInvoice(change);
  if (change.origin === "entity-name-backfill") return decideEntityNames(current, change);
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
    update[LAST_FACT_CHANGE_FIELD] = { origin: change.origin, at };
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
// An Extraction
// ---------------------------------------------------------------------------

/**
 * One Extraction's reading, as the complete File update (#639).
 *
 * Refused as a whole on a File with a Hand Correction unless forced, never
 * merged field by field (#184). Otherwise every derived field is computed on
 * the File as the reading leaves it, after the VAT downgrade guard has decided
 * which VAT evidence survives: the Document Type, the 11 % rate review, the
 * direction review, the repair flags (computed from this reading, #275) and
 * the RKSV review. The Due Date and Debit Date are read off the rows in
 * `extractionFields`. An Extraction re-scores nothing itself: the File's
 * matching runs after it, as it always has.
 */
function decideExtraction(current: CurrentFile, change: ExtractionChange): FactOutcome {
  const { record } = current;
  const refusal = reExtractionRefusal(record, { overwriteCorrections: change.forced === true });
  if (refusal) return refusal;

  const at = change.at ?? Timestamp.now();
  const { reading } = change;
  const update = extractionFields(record, reading);

  Object.assign(
    update,
    readingDerivedFields(
      { ...record, ...update },
      current.linkedTransactions,
      reading.kind === "invoice" ? reading.repairAmbiguousFields : []
    )
  );

  update[LAST_FACT_CHANGE_FIELD] = { origin: change.origin, at };
  update.updatedAt = at;

  return {
    refused: false,
    update,
    followUps: followUpsOf(record, update, false),
    changed: [],
    movedDetails: [],
  };
}

/**
 * The derived fields of a File that a reading of the document, or a ruling
 * that there is nothing to read, leaves (#639, #710): the Document Type, the
 * 11 % rate review, the direction review, the repair flags (from this reading
 * alone, #275) and the RKSV review, computed on the File as the write leaves
 * it. An Extraction and marking a File Not Invoice both call this, so a File
 * ruled not an invoice gets the same derived fields whichever path ruled it.
 */
function readingDerivedFields(
  stored: Record<string, unknown>,
  linkedTransactions: DirectionTransactionFacts[],
  repairAmbiguousFields: string[]
): Record<string, unknown> {
  const file = stored as FileRecord;
  return {
    ...documentTypeFields(classifyFileRecord(file)),
    ...vatRateReviewFields(reviewFileRecordVatRates(file)),
    ...directionReviewFields(reviewDirection(toDirectionFacts(file, linkedTransactions))),
    ...repairReviewFields(
      reviewRepair({ ambiguousFields: repairAmbiguousFields, isNotInvoice: file.isNotInvoice === true })
    ),
    ...rksvCodeReviewFields(reviewFileRecordRksvCode(file)),
  };
}

// ---------------------------------------------------------------------------
// The other writers (#640)
// ---------------------------------------------------------------------------

/**
 * Marking a File Not Invoice: the facts an Extraction's not-invoice reading
 * clears, the matching reset, and the Hand Correction record cleared for the
 * figures it wipes (`notInvoice.ts`). Its derived fields come from the same
 * derivation as an Extraction's (#710), so the Document Type, the direction
 * review and the other review flags are the ones Extraction's not-invoice
 * path leaves, and a moved Document Type re-derives the connected
 * Transactions' Documentation State.
 */
function decideNotInvoice(current: CurrentFile, change: NotInvoiceChange): FactOutcome {
  const { record } = current;
  const update = notInvoiceFields(record, change.reason);
  Object.assign(update, readingDerivedFields({ ...record, ...update }, current.linkedTransactions, []));
  return stamped(record, update, change.origin, change.at ?? Timestamp.now());
}

/**
 * The identity sweep: the direction, the counterparty and the recipient
 * verdict it derived, unless a Hand Correction keeps the direction
 * (`identitySweep.ts`). Nothing moved, nothing written: a sweep does not
 * re-classify an unchanged File. When something moved, the Document Type, the
 * 11 % rate review, the RKSV review and the direction review are computed on
 * the File as it is left. The repair flags are an Extraction's and stay.
 */
function decideIdentitySweep(current: CurrentFile, change: IdentitySweepChange): FactOutcome {
  const { record } = current;
  const { update, keptDirection } = sweepFields(record, change.derived);
  if (Object.keys(update).length === 0) {
    return { refused: false, update, followUps: [], changed: [], movedDetails: [], keptDirection };
  }

  const swept = { ...record, ...update } as FileRecord;
  Object.assign(update, documentTypeFields(classifyFileRecord(swept)));
  Object.assign(update, vatRateReviewFields(reviewFileRecordVatRates(swept)));
  Object.assign(update, rksvCodeReviewFields(reviewFileRecordRksvCode(swept)));
  Object.assign(
    update,
    directionReviewFields(reviewDirection(toDirectionFacts(swept, current.linkedTransactions)))
  );
  return { ...stamped(record, update, change.origin, change.at ?? Timestamp.now()), keptDirection };
}

/** A generated invoice: the invoice's facts, no derived field (`generatedInvoice.ts`). */
function decideGeneratedInvoice(change: GeneratedInvoiceChange): FactOutcome {
  const update = change.invoice ? issuedInvoiceFacts(change.invoice) : draftInvoiceFacts();
  return stamped({}, update, change.origin, change.at ?? Timestamp.now());
}

/** The entity-name backfill: the decoded names, nothing derived (`entityNames.ts`). */
function decideEntityNames(current: CurrentFile, change: EntityNameBackfillChange): FactOutcome {
  const update = decodedEntityNameFields(current.record);
  if (Object.keys(update).length === 0) {
    return { refused: false, update, followUps: [], changed: [], movedDetails: [] };
  }
  return stamped(current.record, update, change.origin, change.at ?? Timestamp.now());
}

/** Stamp a write that is neither a Hand Correction nor an Extraction, and derive its follow-ups. */
function stamped(
  record: Record<string, unknown>,
  update: Record<string, unknown>,
  origin: FactChange["origin"],
  at: Timestamp
): FactUpdate {
  update[LAST_FACT_CHANGE_FIELD] = { origin, at };
  update.updatedAt = at;
  return {
    refused: false,
    update,
    followUps: followUpsOf(record, update, false),
    changed: [],
    movedDetails: [],
  };
}

/**
 * The fact fields of a generated invoice's File, for the batch or transaction
 * that writes its invoice. Never refused.
 */
export function generatedInvoiceFileFacts(
  invoice: Invoice | null,
  at: Timestamp = Timestamp.now()
): Record<string, unknown> {
  const outcome = decideFactChange(
    { record: {}, linkedTransactions: [] },
    { origin: "generated-invoice", invoice, at }
  );
  if (outcome.refused) throw new Error(outcome.message);
  return outcome.update;
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

/** `mayRescore`: a Hand Correction that moved something. An Extraction never re-scores here. */
function followUpsOf(
  record: Record<string, unknown>,
  update: Record<string, unknown>,
  mayRescore: boolean
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
    mayRescore &&
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
