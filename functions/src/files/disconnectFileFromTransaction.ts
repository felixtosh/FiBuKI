/**
 * Disconnect a file from a transaction
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface DisconnectFileRequest {
  fileId: string;
  transactionId: string;
  /** If true, adds the file to transaction's rejectedFileIds to prevent auto-reconnection */
  rejectFile?: boolean;
}

interface DisconnectFileResponse {
  success: boolean;
}

export const disconnectFileFromTransactionCallable = createCallable<
  DisconnectFileRequest,
  DisconnectFileResponse
>(
  { name: "disconnectFileFromTransaction" },
  async (ctx, request) => {
    const { fileId, transactionId, rejectFile = false } = request;

    if (!fileId || !transactionId) {
      throw new HttpsError("invalid-argument", "fileId and transactionId are required");
    }

    // Verify file ownership
    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    if (fileSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "File access denied");
    }

    // Verify transaction ownership
    const transactionRef = ctx.db.collection("transactions").doc(transactionId);
    const transactionSnap = await transactionRef.get();

    if (!transactionSnap.exists) {
      throw new HttpsError("not-found", "Transaction not found");
    }

    const transactionData = transactionSnap.data()!;
    if (transactionData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Transaction access denied");
    }

    // Find the connection document
    const connectionQuery = await ctx.db
      .collection("fileConnections")
      .where("fileId", "==", fileId)
      .where("transactionId", "==", transactionId)
      .where("userId", "==", ctx.userId)
      .limit(1)
      .get();

    // Check if this is the last file and transaction has no noReceiptCategory
    const currentFileIds = transactionData.fileIds || [];
    const willHaveNoFiles = currentFileIds.length <= 1;
    const hasNoReceiptCategory = !!transactionData.noReceiptCategoryId;

    const now = Timestamp.now();
    const batch = ctx.db.batch();

    // 1. Delete junction document if it exists
    if (!connectionQuery.empty) {
      batch.delete(connectionQuery.docs[0].ref);
    }

    // 2. Update file's transactionIds array
    batch.update(fileRef, {
      transactionIds: FieldValue.arrayRemove(transactionId),
      updatedAt: now,
    });

    // 3. Update transaction's fileIds array and potentially mark incomplete
    const transactionUpdate: Record<string, unknown> = {
      fileIds: FieldValue.arrayRemove(fileId),
      updatedAt: now,
    };

    // Mark incomplete only if no files remain AND no no-receipt category
    if (willHaveNoFiles && !hasNoReceiptCategory) {
      transactionUpdate.isComplete = false;
    }

    // If rejecting, add to both rejectedFileIds (legacy) and rejectedFiles (with timestamp)
    if (rejectFile) {
      transactionUpdate.rejectedFileIds = FieldValue.arrayUnion(fileId);

      // Find the fileConnection to get match confidence before it's deleted
      const connectionData = !connectionQuery.empty ? connectionQuery.docs[0].data() : null;
      transactionUpdate.rejectedFiles = FieldValue.arrayUnion({
        fileId,
        rejectedAt: now,
        matchConfidence: connectionData?.matchConfidence ?? null,
      });
    }

    batch.update(transactionRef, transactionUpdate);

    await batch.commit();

    console.log(`[disconnectFileFromTransaction] Disconnected file ${fileId} from transaction ${transactionId}`);

    return { success: true };
  }
);
