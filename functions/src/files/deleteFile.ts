/**
 * Delete a file.
 *
 * Deleting hides the File and can be undone by `restoreFile`; the document row
 * and its stored bytes both survive. Destroying a deleted File is a Purge, and
 * a Purge is its own writer — this callable has no parameter that reaches one.
 * See docs/adr/0006-deleting-a-file-is-reversible.md.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface DeleteFileRequest {
  fileId: string;
}

interface DeleteFileResponse {
  success: boolean;
  deletedConnections: number;
}

export const deleteFileCallable = createCallable<
  DeleteFileRequest,
  DeleteFileResponse
>(
  {
    name: "deleteFile",
    timeoutSeconds: 120,
  },
  async (ctx, request) => {
    const { fileId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    // Verify ownership
    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    const fileData = fileSnap.data()!;
    if (fileData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    const now = Timestamp.now();
    let deletedConnections = 0;

    // 1. Delete all fileConnections and update linked transactions
    const connectionsQuery = await ctx.db
      .collection("fileConnections")
      .where("fileId", "==", fileId)
      .where("userId", "==", ctx.userId)
      .get();

    if (!connectionsQuery.empty) {
      const BATCH_SIZE = 500;

      for (let i = 0; i < connectionsQuery.docs.length; i += BATCH_SIZE) {
        const batch = ctx.db.batch();
        const chunk = connectionsQuery.docs.slice(i, i + BATCH_SIZE);

        for (const connDoc of chunk) {
          const conn = connDoc.data();

          // Delete connection document
          batch.delete(connDoc.ref);
          deletedConnections++;

          // Update transaction to remove this file
          const transactionRef = ctx.db.collection("transactions").doc(conn.transactionId);
          const transactionSnap = await transactionRef.get();

          if (transactionSnap.exists && transactionSnap.data()!.userId === ctx.userId) {
            const txData = transactionSnap.data()!;
            const currentFileIds = (txData.fileIds || []) as string[];
            const remainingFileIds = currentFileIds.filter((id: string) => id !== fileId);

            // Recalculate isComplete
            const hasFiles = remainingFileIds.length > 0;
            const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
            const isComplete = hasFiles || hasNoReceiptCategory;

            batch.update(transactionRef, {
              fileIds: FieldValue.arrayRemove(fileId),
              isComplete,
              updatedAt: now,
            });
          }
        }

        await batch.commit();
      }
    }

    // 2. Also handle legacy connections via file's transactionIds array
    const fileTransactionIds = (fileData.transactionIds || []) as string[];
    for (const transactionId of fileTransactionIds) {
      // Skip if already handled via fileConnections
      const wasHandled = connectionsQuery.docs.some(
        (d) => d.data().transactionId === transactionId
      );
      if (wasHandled) continue;

      const transactionRef = ctx.db.collection("transactions").doc(transactionId);
      const transactionSnap = await transactionRef.get();

      if (transactionSnap.exists && transactionSnap.data()!.userId === ctx.userId) {
        const txData = transactionSnap.data()!;
        const currentFileIds = (txData.fileIds || []) as string[];
        const remainingFileIds = currentFileIds.filter((id: string) => id !== fileId);

        const hasFiles = remainingFileIds.length > 0;
        const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
        const isComplete = hasFiles || hasNoReceiptCategory;

        await transactionRef.update({
          fileIds: FieldValue.arrayRemove(fileId),
          isComplete,
          updatedAt: now,
        });
        deletedConnections++;
      }
    }

    // 3. Hide the file. The row stays — a Sync-sourced File needs it to
    // deduplicate against, and every File needs it to be restorable — and the
    // stored document is not touched at all.
    // Clear transactionIds so it stops showing in transaction file lists.
    await fileRef.update({
      deletedAt: now,
      transactionIds: [],
      updatedAt: now,
    });
    console.log(`[deleteFile] Deleted file ${fileId} (reversible)`);

    return { success: true, deletedConnections };
  }
);
