/**
 * The whole write a hand correction makes to a file record (#149).
 *
 * `buildExtractionCorrection` owns the corrected values and the provenance
 * stamp. Three stored artefacts are derived from those values and go stale the
 * moment they move: the § 11 document classification (#104), the 11% rate
 * review flag (#203) and the direction review (#233). Recomputing them is
 * therefore part of applying a correction, not something a caller remembers to
 * do — the MCP tool did remember, and the UI path, which never came through
 * here at all, did not.
 *
 * Kept out of `extractionCorrectionOps` so that module stays a value builder
 * with no opinion about what else a file record carries. It is not pure, and
 * cannot be: the direction review compares the document against the
 * transactions it is linked to, which means a read. The bound on a hand-set tip
 * (#310) is here for exactly that reason too — one of the two totals it can be
 * measured against is the bank line's, which only a read knows.
 */

import type { Firestore } from "firebase-admin/firestore";
import { classifyFileRecord, documentTypeFields, FileRecord } from "../documents/adapter";
import { reviewFileRecordVatRates, vatRateReviewFields } from "../documents/vatRateReview";
import {
  computeDirectionReviewFields,
  readLinkedTransactions,
} from "../documents/syncDirectionReview";
import { checkTipBound, TipBound } from "./tipBound";
import {
  BuiltCorrection,
  FileExtractionCorrection,
  buildExtractionCorrection,
} from "./extractionCorrectionOps";

/** What the correction declares about itself, as opposed to what it sets. */
export interface CorrectionOptions {
  /**
   * The tip being set is NOT printed on the invoice (#310) — the terminal took
   * it and the Beleg is silent, so the document total is the Entgelt and the
   * tip sits on top of it. Moves the bound from the document total to the
   * transaction total; it does not lift it.
   *
   * A property of this correction, not a setting: the next correction to the
   * same file states it again or does not.
   */
  tipNotPrinted?: boolean;
}

/**
 * Build the update for a correction against the stored record, including the
 * derived fields that correction invalidates.
 *
 * `record` is the file as stored: the provenance stamp merges onto the marks
 * earlier corrections left, and everything derived is recomputed from the
 * record as it will be *after* this write, not as it is now.
 *
 * The value rules throw `ExtractionCorrectionError`, and so does the tip bound;
 * both do it before anything is written, so a caller that maps that error onto
 * its own surface still sees it.
 */
export async function buildCorrectedFileUpdate(
  db: Firestore,
  fields: FileExtractionCorrection,
  record: Record<string, unknown>,
  options: CorrectionOptions = {}
): Promise<BuiltCorrection> {
  const built = buildExtractionCorrection(fields, record);

  const corrected = { ...record, ...built.updates } as FileRecord;

  // #310. Only a correction that actually sets the tip is measured: a file
  // carrying an oversized tip from before this guard existed must still be
  // repairable through every other field, and the panel re-sends the stored
  // tip on every save. The bound that applied is stored beside the figure, so
  // the check is reproducible and an overridden tip is legible as one.
  if (fields.tipAmount !== undefined) {
    built.updates.extractedTipBound = await boundHandSetTip(
      db,
      record,
      corrected.extractedTipAmount,
      corrected.extractedAmount,
      options.tipNotPrinted === true
    );
  }

  Object.assign(built.updates, documentTypeFields(classifyFileRecord(corrected)));
  Object.assign(built.updates, vatRateReviewFields(reviewFileRecordVatRates(corrected)));

  // Setting the direction by hand has to clear the flag that said it was wrong,
  // which is the whole point of being able to set it (#233). It reads the
  // linked transactions, so this is the one part that is not a pure function of
  // the record.
  Object.assign(built.updates, await computeDirectionReviewFields(db, corrected));

  return built;
}

/**
 * Measure the tip this correction leaves on the record.
 *
 * The transaction total is read only when it is the total that matters: the
 * default bound needs nothing but the record, and a correction that clears the
 * tip needs neither.
 */
async function boundHandSetTip(
  db: Firestore,
  record: Record<string, unknown>,
  correctedTip: unknown,
  correctedTotal: unknown,
  notPrinted: boolean
): Promise<TipBound | null> {
  const tip = typeof correctedTip === "number" ? correctedTip : null;
  const needsBankLine = tip !== null && tip !== 0 && notPrinted;

  return checkTipBound({
    tip,
    documentTotal: typeof correctedTotal === "number" ? correctedTotal : null,
    transactionTotal: needsBankLine ? await readTransactionTotal(db, record) : null,
    notPrinted,
  });
}

/**
 * What the bank was charged across every transaction this file is linked to.
 *
 * Summed rather than taken from the first link, because a document can settle
 * over several charges; `Math.abs` because a bound has no direction. Null when
 * nothing resolves — the bound then has nothing to measure against, which is a
 * refusal rather than a licence.
 */
async function readTransactionTotal(
  db: Firestore,
  record: Record<string, unknown>
): Promise<number | null> {
  const transactionIds = (record.transactionIds as string[] | undefined) ?? [];
  const transactions = await readLinkedTransactions(db, transactionIds);
  if (transactions.length === 0) return null;
  return transactions.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}
