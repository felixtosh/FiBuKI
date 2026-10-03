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
 * A restore refused because parts the File was Split into still exist (#550):
 * the original and its parts would document one payment twice.
 */
export class SplitPartsLiveError extends Error {
  constructor(readonly liveParts: Array<{ fileId: string; fileName: string | null }>) {
    super(
      "This File was split, and its parts still exist: " +
        liveParts.map((p) => `"${p.fileName ?? p.fileId}"`).join(", ") +
        ". Delete the parts first to undo the Split."
    );
    this.name = "SplitPartsLiveError";
  }
}

/** The parts of a Split original that are not deleted. */
async function liveSplitParts(
  db: FirebaseFirestore.Firestore,
  userId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<Array<{ fileId: string; fileName: string | null }>> {
  const partIds = Array.isArray(fileData.splitInto) ? (fileData.splitInto as unknown[]) : [];
  const live: Array<{ fileId: string; fileName: string | null }> = [];
  for (const partId of partIds) {
    if (typeof partId !== "string") continue;
    const part = (await db.collection("files").doc(partId).get()).data();
    if (part && part.userId === userId && !part.deletedAt) {
      live.push({ fileId: partId, fileName: typeof part.fileName === "string" ? part.fileName : null });
    }
  }
  return live;
}

/**
 * The restore itself, shared by the callable and the tool surface (#267).
 *
 * Callers check existence and ownership first. Only the File comes back: the
 * Transaction attachments the delete removed are not recreated. A Split
 * original stays deleted while any of its parts exists (#550).
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

  const liveParts = await liveSplitParts(db, userId, fileData);
  if (liveParts.length > 0) throw new SplitPartsLiveError(liveParts);

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

    try {
      await performRestoreFile(ctx.db, ctx.userId, fileId, fileData);
    } catch (error) {
      if (error instanceof SplitPartsLiveError) {
        throw new HttpsError("failed-precondition", error.message);
      }
      throw error;
    }
    return { success: true };
  }
);
