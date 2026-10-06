/**
 * "Not an invoice" state transitions, shared by the callables and the MCP tools.
 *
 * The callables (markFileAsNotInvoice / unmarkFileAsNotInvoice) drive the UI
 * buttons; the tool handlers of the same name drive the MCP surface. Both must
 * write the identical field set, or a file flagged by an agent and a file
 * flagged by a click end up in different states. Marking clears facts, so the
 * File facts module decides it (#640); un-marking writes no fact and is
 * built here.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { enqueueExtraction } from "../extraction/extractionQueue";
import { reExtractionRefusal } from "../fileFacts/factChange";
import { applyFactChange } from "../fileFacts/applyFactChange";

/**
 * Fields the transition reads. Deliberately narrow: everything else on the
 * file document is irrelevant to the decision.
 */
export interface NotInvoiceFileState {
  partnerMatchedBy?: string | null;
}

/**
 * Mark a File as "not an invoice", through the File facts module (#640).
 *
 * The module clears the extracted data, because there is nothing to extract
 * from a document that is not an invoice, resets the partner and transaction
 * matching derived from it, and clears the Hand Correction record for the
 * figures it wipes, all in one write. A manually-set Partner survives. The
 * caller has checked the File is the User's; a File that is gone by now, or
 * is not theirs, throws and nothing is written.
 */
export async function markFileNotInvoice(
  db: Firestore,
  fileId: string,
  userId: string,
  reason?: string
): Promise<void> {
  const outcome = await applyFactChange(db, { fileId, userId, change: { origin: "not-invoice", reason } });
  if (outcome.refused) throw new Error(outcome.message);
}

/**
 * Unmarking restores the file as an invoice and re-opens extraction, which is
 * what recovers the data `markFileNotInvoice` cleared. Nothing fires
 * on the write itself: whoever writes these updates calls
 * `queueExtractionAfterUnmark` once the write has committed.
 *
 * `hasManualConnections` says whether the file is manually connected to at
 * least one transaction. When it is, transaction matching is left alone —
 * re-running it would discard a connection a human made by hand.
 */
export function buildUnmarkNotInvoiceUpdates(
  fileData: NotInvoiceFileState,
  hasManualConnections: boolean
): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    isNotInvoice: false,
    notInvoiceReason: null,
    // Skip classification - user has confirmed it's an invoice
    classificationComplete: true,
    // Waiting for Extraction again; the caller queues it.
    extractionComplete: false,
    extractionError: null,
    // Queued again until a worker picks it up (#603).
    extractionStartedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  // Only reset partner if NOT manually set (preserve user's intentional choice)
  if (fileData.partnerMatchedBy !== "manual") {
    updates.partnerId = null;
    updates.partnerType = null;
    updates.partnerMatchedBy = null;
    updates.partnerMatchConfidence = null;
    updates.partnerMatchComplete = false;
    updates.partnerSuggestions = [];
  }

  // Only reset transaction matching if no manual connections exist
  if (!hasManualConnections) {
    updates.transactionMatchComplete = false;
    updates.transactionSuggestions = [];
  }

  return updates;
}

/**
 * Why this File may not be un-marked, or null when it may (#639).
 *
 * Un-marking re-extracts the File, so a File with a Hand Correction is
 * refused as every re-extraction is (#184), before anything is written. The
 * caller hears it at once instead of finding the File re-read later. Un-mark
 * takes no overwrite of its own: the forced re-extraction is a Retry with
 * `overwriteCorrections`, which on a File marked Not Invoice re-extracts it as
 * an invoice, the same as un-marking would.
 */
export function unmarkRefusal(
  fileData: Record<string, unknown>
): { message: string; details: HandCorrectionRefusalDetails } | null {
  const refusal = reExtractionRefusal(fileData, {});
  if (!refusal) return null;
  const fields = refusal.fields ?? [];
  return {
    message:
      `File carries hand corrections a re-extraction would discard (${fields.join(", ")}). ` +
      "Un-marking it as not an invoice re-extracts it, so it is refused. " +
      "Retry its extraction with overwriteCorrections to re-extract it as an invoice anyway.",
    details: { code: "HAND_CORRECTED", fields },
  };
}

/**
 * The structured details of a Hand Correction refusal on a callable (#639):
 * the UI reads the fields from here and asks before overwriting them.
 */
export interface HandCorrectionRefusalDetails {
  code: "HAND_CORRECTED";
  fields: string[];
}

/**
 * Ask for the Extraction an unmark re-opened. Call it after the unmark has
 * committed, never inside a transaction: the callback can run more than once,
 * and on self-host the job is a write outside it.
 *
 * Classification is skipped because the person just ruled the document an
 * invoice, as a Retry does for a classification the user overrode. A `retry`
 * ask on a File already waiting joins its job, so a second ask is harmless.
 */
export async function queueExtractionAfterUnmark(fileId: string, userId: string): Promise<void> {
  await enqueueExtraction({ fileId, userId, skipClassification: true, kind: "retry" });
}
