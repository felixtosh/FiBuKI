/**
 * Trigger File Matching Worker
 *
 * Callable function to trigger a file matching worker via the Next.js API.
 * This is a bridge between Cloud Functions and the worker system.
 *
 * The worker will:
 * 1. Search local files and Gmail for matches
 * 2. Score and compare all candidates
 * 3. Connect the best match
 * 4. Create a notification with the transcript
 */

import { toDateSafe } from "../utils/toDateSafe";
import { createCallable, HttpsError } from "../utils/createCallable";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const db = getFirestore();

// ============================================================================
// Types
// ============================================================================

interface TriggerFileMatchingRequest {
  fileId: string;
}

interface TriggerFileMatchingResponse {
  success: boolean;
  message: string;
  workerRequestId?: string;
}

// ============================================================================
// Callable
// ============================================================================

/**
 * Trigger a file matching worker for a specific file.
 *
 * Instead of calling the Next.js API directly (which requires complex auth),
 * this creates a "workerRequest" document that can be:
 * 1. Polled by the Next.js API
 * 2. Or processed by a dedicated worker Cloud Function later
 *
 * For now, this just creates the request document. The actual execution
 * happens when the user's session picks up the request.
 */
export const triggerFileMatchingWorkerCallable = createCallable<
  TriggerFileMatchingRequest,
  TriggerFileMatchingResponse
>(
  {
    name: "triggerFileMatchingWorker",
  },
  async (ctx, request) => {
    const { fileId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    // Get file data
    const fileDoc = await db.collection("files").doc(fileId).get();
    if (!fileDoc.exists) {
      throw new HttpsError("not-found", `File ${fileId} not found`);
    }

    const fileData = fileDoc.data()!;

    // Check file ownership
    if (fileData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Not authorized to access this file");
    }

    // Build prompt from file data
    const fileInfo = {
      fileName: fileData.fileName || fileData.name,
      amount: fileData.extractedAmount,
      date: toDateSafe(fileData.extractedDate)?.toISOString?.()?.split("T")[0],
      partner: fileData.extractedPartner || fileData.partnerName,
    };

    const promptParts = [`Find matching transaction for file "${fileInfo.fileName}"`];
    if (fileInfo.amount) {
      promptParts.push(`Amount: ${(fileInfo.amount / 100).toFixed(2)} EUR`);
    }
    if (fileInfo.date) {
      promptParts.push(`Date: ${fileInfo.date}`);
    }
    if (fileInfo.partner) {
      promptParts.push(`Partner: ${fileInfo.partner}`);
    }

    const initialPrompt = promptParts.join(". ");

    // Create worker request document
    // This can be picked up by the frontend or a dedicated processor
    const requestRef = db.collection(`users/${ctx.userId}/workerRequests`).doc();
    await requestRef.set({
      id: requestRef.id,
      workerType: "file_matching",
      initialPrompt,
      triggerContext: {
        fileId,
      },
      triggeredBy: "auto",
      status: "pending",
      createdAt: Timestamp.now(),
    });

    console.log(`[TriggerWorker] Created worker request ${requestRef.id} for file ${fileId}`);

    return {
      success: true,
      message: `Worker request created for file ${fileId}`,
      workerRequestId: requestRef.id,
    };
  }
);
