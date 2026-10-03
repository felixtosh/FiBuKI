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
 * transactions it is linked to, which means a read.
 */

import type { Firestore } from "firebase-admin/firestore";
import { classifyFileRecord, documentTypeFields, FileRecord } from "../documents/adapter";
import { reviewFileRecordVatRates, vatRateReviewFields } from "../documents/vatRateReview";
import { retireRepairAmbiguity } from "../documents/repairReview";
import { computeDirectionReviewFields } from "../documents/syncDirectionReview";
import { checkTipBound } from "./tipBound";
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
   * tip sits on top of it. The document then has nothing to bound it by, so
   * the document bound does not apply (#554); the declaration is recorded as
   * `{ bound: "not-printed" }`.
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
  // the check is reproducible and an unprinted tip is legible as one.
  if (fields.tipAmount !== undefined) {
    built.updates.extractedTipBound = checkTipBound({
      tip: typeof corrected.extractedTipAmount === "number" ? corrected.extractedTipAmount : null,
      documentTotal: typeof corrected.extractedAmount === "number" ? corrected.extractedAmount : null,
      notPrinted: options.tipNotPrinted === true,
    });
  }

  Object.assign(built.updates, documentTypeFields(classifyFileRecord(corrected)));
  Object.assign(built.updates, vatRateReviewFields(reviewFileRecordVatRates(corrected)));

  // The repair flag is not recomputed, it is retired per field (#301): a value
  // a person typed replaces the guess the flag was warning about.
  Object.assign(built.updates, retireRepairAmbiguity(record, Object.keys(built.updates)));

  // Setting the direction by hand has to clear the flag that said it was wrong,
  // which is the whole point of being able to set it (#233). It reads the
  // linked transactions, so this is the one part that is not a pure function of
  // the record.
  Object.assign(built.updates, await computeDirectionReviewFields(db, corrected));

  return built;
}

