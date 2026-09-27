/**
 * Restore a soft-deleted file
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface RestoreFileRequest {
  fileId: string;
}

interface RestoreFileResponse {
  success: boolean;
}

/**
 * The restore itself, shared by the callable and the tool surface (#267).
 *
 * Callers check existence and ownership first. Only the File comes back: the
 * Transaction attachments the delete removed are not recreated.
 */
export async function performRestoreFile(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<{ success: boolean; restored: boolean }> {
  if (!fileData.deletedAt) {
    // File is not deleted, nothing to restore
    return { success: true, restored: false };
  }

  await db.collection("files").doc(fileId).update({
    deletedAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  console.log(`[restoreFile] Restored file ${fileId}`, { userId });

  return { success: true, restored: true };
}

export const restoreFileCallable = createCallable<
  RestoreFileRequest,
  RestoreFileResponse
>(
  { name: "restoreFile" },
  async (ctx, request) => {
    const { fileId } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    const fileSnap = await ctx.db.collection("files").doc(fileId).get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    const fileData = fileSnap.data()!;
    if (fileData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    await performRestoreFile(ctx.db, ctx.userId, fileId, fileData);
    return { success: true };
  }
);
