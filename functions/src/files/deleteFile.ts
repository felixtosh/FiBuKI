/**
 * Delete a file.
 *
 * Deleting hides the File and can be undone by `restoreFile`; the document row
 * and its stored bytes both survive. Destroying a deleted File is a Purge, and
 * a Purge is its own writer — this callable has no parameter that reaches one.
 * See docs/adr/0006-deleting-a-file-is-reversible.md.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { generatedInvoiceRefusal } from "./generatedInvoiceGuard";
import { detachFile, type DetachedTransaction } from "../fileConnections/writer";
import { activityEntry, logActivity } from "../utils/activity";

interface DeleteFileRequest {
  fileId: string;
}

interface DeleteFileResponse {
  success: boolean;
  deletedConnections: number;
}

export type { DetachedTransaction };

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
  fileData: FirebaseFirestore.DocumentData,
  /** Who deleted it and why, for the activity log (#752). Defaults to the User. */
  how: { actor: "manual" | "auto" | "ai"; summary: string } = { actor: "manual", summary: "File deleted" }
): Promise<PerformDeleteFileResult> {
  // 1. Hide the file. The row stays — a Sync-sourced File needs it to
  // deduplicate against, and every File needs it to be restorable — and the
  // stored document is not touched at all.
  // Hidden before it is detached: the File Connection writer refuses a
  // deleted File, so no connect (auto-connect, Partner matching) can attach
  // it again between the detach and the hide (#612).
  // A File that was attached when it was deleted is stamped as such, because
  // the delete clears the attachment fields the Purge confirmation would
  // otherwise read its retention warning from (#268).
  const now = Timestamp.now();
  const fileRef = db.collection("files").doc(fileId);
  const fileTransactionIds = (fileData.transactionIds || []) as string[];
  const listedAttached = fileTransactionIds.length > 0;
  await fileRef.update({
    deletedAt: now,
    updatedAt: now,
    ...(listedAttached ? { hadTransactionConnections: true } : {}),
    ...logActivity(activityEntry({ type: "file_deleted", actor: how.actor, summary: how.summary }, now)),
  });

  // 2. Take the File off every Transaction, through the File Connection
  // writer (#612). A Partner the payee rule filled from it is derived again
  // from the Files that remain (#584).
  const { removedConnections, detachedTransactions } = await detachFile(db, userId, fileId, fileData, how);
  if (!listedAttached && detachedTransactions.length > 0) {
    // Attached by a record or a Transaction's list the File did not carry.
    await fileRef.update({ hadTransactionConnections: true });
  }
  console.log(`[deleteFile] Deleted file ${fileId} (reversible)`);

  return { success: true, deletedConnections: removedConnections, detachedTransactions };
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
