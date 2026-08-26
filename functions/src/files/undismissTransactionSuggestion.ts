/**
 * Undo a dismissed transaction suggestion for a file.
 *
 * The twin of dismissTransactionSuggestion, and the second half of the pair the
 * MCP surface exposes as undismiss_transaction_suggestion. The field-writes
 * live in dismissSuggestionOps, shared with that tool handler, so an undo by a
 * click and an undo by an agent land in the same state.
 *
 * Note that unrejectFileFromTransaction is a different mechanism entirely: it
 * clears the rejection fields on the transaction document, whereas dismissal lives
 * in `dismissedTransactionIds` / `dismissedTransactions` on the file. Neither
 * undoes the other.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import {
  buildUndismissSuggestionUpdates,
  type DismissibleFileState,
} from "./dismissSuggestionOps";

interface UndismissTransactionSuggestionRequest {
  fileId: string;
  transactionId: string;
}

interface UndismissTransactionSuggestionResponse {
  success: boolean;
  /** False when the pair was not dismissed, in which case nothing was written. */
  wasDismissed: boolean;
}

export const undismissTransactionSuggestionCallable = createCallable<
  UndismissTransactionSuggestionRequest,
  UndismissTransactionSuggestionResponse
>(
  { name: "undismissTransactionSuggestion" },
  async (ctx, request) => {
    const { fileId, transactionId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }
    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    const fileRef = ctx.db.collection("files").doc(fileId);

    // Read and write in one transaction, for the same reason dismissal does:
    // the builder rewrites whole arrays, so a concurrent rejection on the same
    // file would otherwise be lost.
    const { wasDismissed } = await ctx.db.runTransaction(async (tx) => {
      const fileSnap = await tx.get(fileRef);

      if (!fileSnap.exists) {
        throw new HttpsError("not-found", "File not found");
      }

      const fileData = fileSnap.data()!;
      if (fileData.userId !== ctx.userId) {
        throw new HttpsError("permission-denied", "Access denied");
      }

      const outcome = buildUndismissSuggestionUpdates(
        fileData as DismissibleFileState,
        transactionId
      );

      // Undoing a pair that was never dismissed writes nothing — not even
      // updatedAt — and Firestore refuses an empty update object anyway.
      if (Object.keys(outcome.updates).length > 0) {
        tx.update(fileRef, outcome.updates);
      }

      return outcome;
    });

    console.log(`[undismissTransactionSuggestion] Restored suggestion for file ${fileId}`, {
      userId: ctx.userId,
      transactionId,
      wasDismissed,
    });

    return { success: true, wasDismissed };
  }
);
