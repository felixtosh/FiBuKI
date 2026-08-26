/**
 * Remove a file from a transaction's rejected list.
 *
 * Allows the file to be auto-matched to this transaction again — which, before
 * fork #102, it did not: only the legacy `rejectedFileIds` array was cleared
 * and the surviving `rejectedFiles` record kept the pair excluded forever. The
 * field writes now live in rejectFileOps, so both shapes move together.
 *
 * Note that dismissTransactionSuggestion is a different mechanism entirely: it
 * writes `dismissedTransactionIds` / `dismissedTransactions` on the *file*,
 * whereas rejection lives on the *transaction*. Neither undoes the other.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { buildUnrejectFileUpdates, type RejectableTransactionState } from "./rejectFileOps";

interface UnrejectFileFromTransactionRequest {
  fileId: string;
  transactionId: string;
}

interface UnrejectFileFromTransactionResponse {
  success: boolean;
  /** False when the file was not rejected, in which case nothing was written. */
  wasRejected: boolean;
}

export const unrejectFileFromTransactionCallable = createCallable<
  UnrejectFileFromTransactionRequest,
  UnrejectFileFromTransactionResponse
>(
  { name: "unrejectFileFromTransaction" },
  async (ctx, request) => {
    const { fileId, transactionId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }
    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    const transactionRef = ctx.db.collection("transactions").doc(transactionId);

    // Read and write in one transaction: the builder rewrites both arrays
    // whole, so a concurrent rejection on the same transaction would otherwise
    // be lost.
    const { wasRejected } = await ctx.db.runTransaction(async (tx) => {
      const transactionSnap = await tx.get(transactionRef);

      if (!transactionSnap.exists) {
        throw new HttpsError("not-found", "Transaction not found");
      }

      const txData = transactionSnap.data()!;
      if (txData.userId !== ctx.userId) {
        throw new HttpsError("permission-denied", "Access denied");
      }

      const outcome = buildUnrejectFileUpdates(txData as RejectableTransactionState, fileId);

      // Un-rejecting a pair that was never rejected writes nothing — not even
      // updatedAt — and Firestore refuses an empty update object anyway.
      if (Object.keys(outcome.updates).length > 0) {
        tx.update(transactionRef, outcome.updates);
      }

      return outcome;
    });

    console.log(`[unrejectFileFromTransaction] Unrejected file ${fileId} from transaction ${transactionId}`, {
      userId: ctx.userId,
      wasRejected,
    });

    return { success: true, wasRejected };
  }
);
