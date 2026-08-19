/**
 * Dismiss a transaction suggestion from a file
 * Removes the suggestion from the file's transactionSuggestions array
 *
 * The field-writes live in dismissSuggestionOps, shared with the MCP tool of
 * the same name, so a pair rejected by a click and a pair rejected by an agent
 * land in the same state.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import {
  buildDismissSuggestionUpdates,
  checkDismissalReason,
  type DismissibleFileState,
} from "./dismissSuggestionOps";

interface DismissTransactionSuggestionRequest {
  fileId: string;
  transactionId: string;
  reason?: string;
}

interface DismissTransactionSuggestionResponse {
  success: boolean;
  dismissedConfidence: number | null;
}

export const dismissTransactionSuggestionCallable = createCallable<
  DismissTransactionSuggestionRequest,
  DismissTransactionSuggestionResponse
>(
  { name: "dismissTransactionSuggestion" },
  async (ctx, request) => {
    const { fileId, transactionId, reason } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }
    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }
    const reasonProblem = checkDismissalReason(reason);
    if (reasonProblem) {
      throw new HttpsError("invalid-argument", reasonProblem);
    }

    const fileRef = ctx.db.collection("files").doc(fileId);

    // Read and write in one transaction: the builder rewrites whole arrays, so
    // two dismissals racing on the same file would otherwise lose one.
    const { dismissedConfidence, alreadyDismissed } = await ctx.db.runTransaction(async (tx) => {
      const fileSnap = await tx.get(fileRef);

      if (!fileSnap.exists) {
        throw new HttpsError("not-found", "File not found");
      }

      const fileData = fileSnap.data()!;
      if (fileData.userId !== ctx.userId) {
        throw new HttpsError("permission-denied", "Access denied");
      }

      const outcome = buildDismissSuggestionUpdates(
        fileData as DismissibleFileState,
        transactionId,
        reason
      );

      tx.update(fileRef, outcome.updates);
      return outcome;
    });

    console.log(`[dismissTransactionSuggestion] Dismissed suggestion for file ${fileId}`, {
      userId: ctx.userId,
      transactionId,
      alreadyDismissed,
    });

    return { success: true, dismissedConfidence };
  }
);
