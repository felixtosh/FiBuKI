/**
 * Delete a draft import and its associated CSV file.
 * Only drafts can be deleted - completed imports are permanent.
 */

import { getStorage } from "firebase-admin/storage";
import { createCallable, HttpsError } from "../utils/createCallable";

interface DeleteDraftImportRequest {
  importId: string;
}

interface DeleteDraftImportResponse {
  success: boolean;
}

export const deleteDraftImportCallable = createCallable<
  DeleteDraftImportRequest,
  DeleteDraftImportResponse
>(
  { name: "deleteDraftImport" },
  async (ctx, request) => {
    const { importId } = request;

    if (!importId) {
      throw new HttpsError("invalid-argument", "importId is required");
    }

    // Get the import record
    const importRef = ctx.db.collection("imports").doc(importId);
    const importSnap = await importRef.get();

    if (!importSnap.exists) {
      throw new HttpsError("not-found", "Import not found");
    }

    const importData = importSnap.data()!;

    // Verify ownership
    if (importData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Import access denied");
    }

    // Verify it's a draft
    if (importData.status !== "draft") {
      throw new HttpsError(
        "failed-precondition",
        "Cannot delete a completed import"
      );
    }

    // Delete the CSV file from storage if it exists
    if (importData.csvStoragePath) {
      try {
        const bucket = getStorage().bucket();
        await bucket.file(importData.csvStoragePath).delete();
        console.log(
          `[deleteDraftImport] Deleted CSV file ${importData.csvStoragePath}`
        );
      } catch (error) {
        // Log but don't fail if file doesn't exist
        console.warn(
          `[deleteDraftImport] Could not delete CSV file: ${error}`
        );
      }
    }

    // Delete the import record
    await importRef.delete();

    console.log(`[deleteDraftImport] Deleted draft import ${importId}`, {
      userId: ctx.userId,
      sourceId: importData.sourceId,
    });

    return { success: true };
  }
);
