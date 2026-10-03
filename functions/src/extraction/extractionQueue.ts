/**
 * Asking for an Extraction (#603).
 *
 * Every entry point that wants a File extracted — upload, undelete, Retry,
 * bulk retry — calls `enqueueExtraction` and returns. What happens next
 * depends on the build:
 *
 *  - Self-host swaps this module for `selfhost/extraction-queue-shim.ts`
 *    (module alias in vitest.selfhost.config.ts), which writes a job for the
 *    extraction worker and returns at once. A slow Extraction then holds
 *    nobody's request and no trigger.
 *  - This file is the Firebase build: Cloud Functions give every trigger and
 *    callable its own instance and time limit, so the Extraction runs here,
 *    inline, as it always has.
 *
 * The caller's checks (ownership, hand corrections, already extracted) run
 * before this, so a refusal still reaches the caller synchronously.
 */

export interface ExtractionRequest {
  fileId: string;
  /** The File's owner. On self-host it decides whose turn the job waits in. */
  userId: string;
  /** Skip the invoice/not-invoice classification: the user already ruled on it. */
  skipClassification: boolean;
  /**
   * `new`: a File waiting for its first Extraction (upload, undelete, boot
   * resweep). A request already waiting for the File wins.
   * `retry`: someone asked again. Replaces the waiting request's options and
   * its reclaim count; if the File is being extracted right now, it runs
   * again once that run ends instead of alongside it.
   */
  kind: "new" | "retry";
}

export async function enqueueExtraction(request: ExtractionRequest): Promise<void> {
  // Loaded on first use: the Extraction code opens Firestore when it loads,
  // and small modules (the not-an-invoice builders) import this one.
  const { extractQueuedFile } = await import("./extractQueuedFile");
  await extractQueuedFile(request.fileId, { skipClassification: request.skipClassification });
}
