/**
 * Re-running extraction on one file, shared by the callable and the MCP tool.
 *
 * The callable (retryFileExtraction) drives the UI's retry action; the
 * `retry_file_extraction` tool handler drives the MCP surface. Both must apply
 * the same eligibility rule and write the same reset, or a file re-extracted by
 * an agent and one re-extracted by a click end up in different states — so the
 * decision and the writes live here and nowhere else. Mirrors
 * files/dismissSuggestionOps, which shares the dismissal builders the same way.
 *
 * Ownership is checked here too. The callable used to fetch a file by id and
 * re-extract it without looking at `userId` or even `request.auth`, which the
 * MCP surface must not inherit: an API key is scoped to one user, and a tool
 * that re-extracts by bare id would cross that boundary and spend another
 * account's extraction budget doing it (fork #74).
 */

import type { Firestore } from "firebase-admin/firestore";
import { enqueueExtraction } from "./extractionQueue";
import { buildRetryResetUpdates } from "./retryReset";

// The reset is its own module so the extraction worker can apply it too
// without importing this one (which imports the queue).
export { buildRetryResetUpdates };
import { correctedFieldsOf } from "../fileFacts/provenance";
import { reExtractionRefusal } from "../fileFacts/factChange";

/** Why a retry was refused. Each surface maps these onto its own error type. */
export type RetryRefusalCode =
  | "NOT_FOUND"
  | "ACCESS_DENIED"
  | "ALREADY_EXTRACTED"
  | "HAND_CORRECTED";

export class RetryExtractionError extends Error {
  constructor(readonly code: RetryRefusalCode, message: string) {
    super(message);
    this.name = "RetryExtractionError";
  }
}

export interface RetryExtractionOptions {
  fileId: string;
  /** The caller's uid. The file must belong to it. */
  userId: string;
  /**
   * Re-extract a file that already extracted without error. Required for the
   * files whose extraction "succeeded" and produced nothing usable — no line
   * items, no VAT — which is the whole population a re-extraction sweep is for.
   */
  force?: boolean;
  /**
   * Re-extract a file carrying hand corrections, replacing what a person set
   * with whatever the model reads this time (#184).
   *
   * Deliberately NOT `force`. Every bulk sweep passes `force: true` as a matter
   * of habit — the UI's own retry button does too, because a cleanly extracted
   * file needs it — so gating corrections on that flag would be no gate at all.
   * A caller that means to overwrite a person's ruling says so per file.
   */
  overwriteCorrections?: boolean;
}

/**
 * True when this file may be re-extracted.
 *
 * A file that errored, or one whose invoice/not-invoice classification the user
 * overrode, is always retryable — that is what the button was built for. A file
 * that completed cleanly needs `force`, so an accidental repeat does not spend
 * an extraction on a document that already has good data.
 */
export function canRetryExtraction(
  fileData: { extractionError?: unknown; isNotInvoice?: unknown; extractionComplete?: unknown },
  force?: boolean
): boolean {
  const hasError = !!fileData.extractionError;
  const wasNotInvoice = fileData.isNotInvoice === true;
  const userMarkedAsInvoice = fileData.isNotInvoice === false && !hasError;

  if (force === true || hasError || wasNotInvoice || userMarkedAsInvoice) return true;
  return !fileData.extractionComplete;
}

/** A Retry the caller was not refused: the File waits for its Extraction. */
export interface RetryExtractionResult {
  queued: true;
  fileId: string;
}

/**
 * Queue a fresh Extraction of one file the caller owns, and return at once.
 *
 * Throws RetryExtractionError for every refusal. The checks run here, before
 * anything is queued, so the caller hears a refusal synchronously; how the
 * Extraction then goes is written on the File, which the caller reads later
 * (#603). A failed Extraction is stamped on the File as `extractionError`.
 *
 * A file carrying hand corrections is refused outright unless the caller asks
 * for those corrections to be overwritten (#184), and the refusal names the
 * fields so the caller can judge what it is about to destroy. The marker itself
 * is not cleared when the overwrite goes ahead: it records that a person once
 * ruled on this document, which stays true, and it keeps the file on the next
 * sweep's exclusion list rather than quietly falling off it after one override.
 */
export async function retryExtractionForFile(
  db: Firestore,
  { fileId, userId, force, overwriteCorrections }: RetryExtractionOptions
): Promise<RetryExtractionResult> {
  const fileRef = db.collection("files").doc(fileId);
  const fileDoc = await fileRef.get();

  if (!fileDoc.exists) {
    throw new RetryExtractionError("NOT_FOUND", "File not found");
  }

  const fileData = fileDoc.data()!;

  if (fileData.userId !== userId) {
    throw new RetryExtractionError("ACCESS_DENIED", "Access denied");
  }

  // Ahead of the force check, because a corrected file has almost always
  // extracted cleanly: whichever refusal fires, the caller needs to hear about
  // the corrections rather than be told to pass the flag that destroys them.
  // The check is the File facts module's (#638), so the retry tool, the retry
  // callable and the bulk retry all hear the same answer.
  const refusal = reExtractionRefusal(fileData, { overwriteCorrections });
  if (refusal) {
    throw new RetryExtractionError("HAND_CORRECTED", refusal.message);
  }
  const correctedFields = correctedFieldsOf(fileData);

  if (!canRetryExtraction(fileData, force)) {
    throw new RetryExtractionError(
      "ALREADY_EXTRACTED",
      "File has already been extracted successfully. Pass force to re-extract it anyway."
    );
  }

  // A classification the user overrode is not re-litigated: they already said
  // this document is an invoice.
  const isUserOverride =
    fileData.isNotInvoice === true ||
    (fileData.isNotInvoice === false && !fileData.extractionError);

  console.log(
    `[${new Date().toISOString()}] Retrying extraction for file: ${fileData.fileName} (${fileId})`,
    { userId, force: force === true, isUserOverride, overwrittenCorrections: correctedFields }
  );

  await fileRef.update(buildRetryResetUpdates(fileData));
  await enqueueExtraction({
    fileId,
    userId,
    skipClassification: isUserOverride,
    kind: "retry",
  });

  return { queued: true, fileId };
}
