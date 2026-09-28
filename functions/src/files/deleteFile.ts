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
import { generatedInvoiceRefusal } from "./generatedInvoiceGuard";

interface DeleteFileRequest {
  fileId: string;
}

interface DeleteFileResponse {
  success: boolean;
  deletedConnections: number;
}

/**
 * A Transaction the deleted File was attached to, as it stands afterwards.
 * `isComplete` false means it re-opened; true means it still has another
 * document or carries a No-document Category.
 */
export interface DetachedTransaction {
  transactionId: string;
  isComplete: boolean;
  date: unknown;
  amount: number | null;
  currency: string | null;
  name: string | null;
  partner: string | null;
}

export interface PerformDeleteFileResult extends DeleteFileResponse {
  detachedTransactions: DetachedTransaction[];
}

/**
 * The delete itself, shared by the callable and the tool surface (#267).
 *
 * Callers check existence and ownership first; this only ever hides the File
 * and detaches it. It has no way to destroy the stored document.
 */
export async function performDeleteFile(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<PerformDeleteFileResult> {
  const fileRef = db.collection("files").doc(fileId);
  const detachedTransactions: DetachedTransaction[] = [];
  const recordDetached = (
    transactionId: string,
    txData: FirebaseFirestore.DocumentData,
    isComplete: boolean
  ) => {
    detachedTransactions.push({
      transactionId,
      isComplete,
      date: txData.date ?? null,
      amount: typeof txData.amount === "number" ? txData.amount : null,
      currency: txData.currency ?? null,
      name: txData.name ?? null,
      partner: txData.partner ?? null,
    });
  };

  const now = Timestamp.now();
  let deletedConnections = 0;

  // 1. Delete all fileConnections and update linked transactions
  const connectionsQuery = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("userId", "==", userId)
    .get();

  if (!connectionsQuery.empty) {
    const BATCH_SIZE = 500;

    for (let i = 0; i < connectionsQuery.docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = connectionsQuery.docs.slice(i, i + BATCH_SIZE);

      for (const connDoc of chunk) {
        const conn = connDoc.data();

        // Delete connection document
        batch.delete(connDoc.ref);
        deletedConnections++;

        // Update transaction to remove this file
        const transactionRef = db.collection("transactions").doc(conn.transactionId);
        const transactionSnap = await transactionRef.get();

        if (transactionSnap.exists && transactionSnap.data()!.userId === userId) {
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
          recordDetached(conn.transactionId, txData, isComplete);
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

    const transactionRef = db.collection("transactions").doc(transactionId);
    const transactionSnap = await transactionRef.get();

    if (transactionSnap.exists && transactionSnap.data()!.userId === userId) {
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
      recordDetached(transactionId, txData, isComplete);
      deletedConnections++;
    }
  }

  // 3. Hide the file. The row stays — a Sync-sourced File needs it to
  // deduplicate against, and every File needs it to be restorable — and the
  // stored document is not touched at all.
  // Clear transactionIds so it stops showing in transaction file lists.
  // A File that was attached when it was deleted is stamped as such, because
  // the delete clears the attachment fields the Purge confirmation would
  // otherwise read its retention warning from (#268).
  const wasAttached = detachedTransactions.length > 0 || fileTransactionIds.length > 0;
  await fileRef.update({
    deletedAt: now,
    transactionIds: [],
    updatedAt: now,
    ...(wasAttached ? { hadTransactionConnections: true } : {}),
  });
  console.log(`[deleteFile] Deleted file ${fileId} (reversible)`);

  return { success: true, deletedConnections, detachedTransactions };
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
    const fileSnap = await ctx.db.collection("files").doc(fileId).get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    const fileData = fileSnap.data()!;
    if (fileData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // The document FiBuKI generated for an invoice cannot be deleted on any
    // surface (ADR-0006, #297); withdrawing the invoice is cancel_invoice.
    const refusal = await generatedInvoiceRefusal(ctx.db, ctx.userId, fileData);
    if (refusal) {
      throw new HttpsError("failed-precondition", refusal);
    }

    const { success, deletedConnections } = await performDeleteFile(
      ctx.db,
      ctx.userId,
      fileId,
      fileData
    );
    return { success, deletedConnections };
  }
);
