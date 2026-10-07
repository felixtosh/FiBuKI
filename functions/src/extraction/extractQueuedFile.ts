/**
 * One waiting Extraction, run to its end (#603).
 *
 * Whoever runs an Extraction that was asked for earlier — the self-host
 * extraction worker, or the Firebase build, which still runs it inline —
 * goes through here, so both apply the same checks and leave the File in the
 * same state.
 *
 * The File is read again at this point rather than trusted from the moment
 * it was queued: on self-host a File can wait a long time, and in that time
 * it can be deleted, purged, or finished by someone else. Each of those
 * drops the request without extracting.
 *
 * `resetFirst` is for a Retry that arrived while the File was being
 * extracted: that run has since written its results, so the Retry's reset
 * is applied again here, and the File runs even though it reads complete.
 *
 * A File with a Hand Correction is refused here, before anything is read
 * from the document, unless the request is the forced re-extraction (#184,
 * #639). This is the one check every queuing path passes through: upload,
 * undelete, the boot resweep, Retry, the bulk retry, un-marking Not Invoice.
 * The paths with a caller have already refused it synchronously; this catches
 * the ones without one, and a correction made while the request waited. The
 * refused File is marked complete, so it does not read "Queued" forever, and
 * keeps its facts as the person left them.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { runExtraction } from "./extractionCore";
import { buildRetryResetUpdates } from "./retryReset";
import { reExtractionRefusal } from "../fileFacts/factChange";
import { activityEntry, logActivity } from "../utils/activity";

/** What became of one waiting Extraction. */
export type QueuedExtractionOutcome = "extracted" | "failed" | "dropped" | "refused";

/**
 * Mark a File failed. A failed Extraction is not retried by itself (#161
 * decision 4): the error stays on the File until someone retries it.
 */
export async function recordExtractionFailure(fileId: string, message: string): Promise<void> {
  await getFirestore().collection("files").doc(fileId).update({
    extractionComplete: true,
    extractionError: message,
    updatedAt: Timestamp.now(),
    ...logActivity(activityEntry({ type: "extraction_failed", actor: "ai", status: "failed", summary: `Reading the document failed: ${message}` })),
  });
}

export async function extractQueuedFile(
  fileId: string,
  options: { skipClassification: boolean; resetFirst?: boolean; overwriteCorrections?: boolean }
): Promise<QueuedExtractionOutcome> {
  const fileRef = getFirestore().collection("files").doc(fileId);
  const fileDoc = await fileRef.get();
  const fileData = fileDoc.data();

  if (
    !fileDoc.exists ||
    !fileData ||
    fileData.deletedAt ||
    fileData.purgedAt ||
    fileData.isFibukiGenerated ||
    (fileData.extractionComplete && !options.resetFirst)
  ) {
    console.log(`File ${fileId} no longer waits for extraction, dropping the request`);
    return "dropped";
  }

  const refusal = reExtractionRefusal(fileData, {
    overwriteCorrections: options.overwriteCorrections === true,
  });
  if (refusal) {
    console.warn(`File ${fileId}: Extraction refused. ${refusal.message}`);
    await fileRef.update({
      extractionComplete: true,
      extractionError: null,
      updatedAt: Timestamp.now(),
    });
    return "refused";
  }

  // "Queued" turns into "Analyzing" here, and nowhere else.
  await fileRef.update({
    ...(options.resetFirst ? buildRetryResetUpdates(fileData) : {}),
    extractionStartedAt: Timestamp.now(),
  });

  console.log(
    `[${new Date().toISOString()}] Starting extraction for file: ${fileData.fileName} (${fileId})`
  );

  try {
    await runExtraction(fileId, fileData, {
      skipClassification: options.skipClassification,
      overwriteCorrections: options.overwriteCorrections === true,
    });
    return "extracted";
  } catch (error) {
    console.error(`Extraction failed for file ${fileId}:`, error);
    await recordExtractionFailure(
      fileId,
      error instanceof Error ? error.message : "Unknown extraction error"
    );
    return "failed";
  }
}
