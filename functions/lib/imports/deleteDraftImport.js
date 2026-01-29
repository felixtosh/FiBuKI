"use strict";
/**
 * Delete a draft import and its associated CSV file.
 * Only drafts can be deleted - completed imports are permanent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteDraftImportCallable = void 0;
const storage_1 = require("firebase-admin/storage");
const createCallable_1 = require("../utils/createCallable");
exports.deleteDraftImportCallable = (0, createCallable_1.createCallable)({ name: "deleteDraftImport" }, async (ctx, request) => {
    const { importId } = request;
    if (!importId) {
        throw new createCallable_1.HttpsError("invalid-argument", "importId is required");
    }
    // Get the import record
    const importRef = ctx.db.collection("imports").doc(importId);
    const importSnap = await importRef.get();
    if (!importSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Import not found");
    }
    const importData = importSnap.data();
    // Verify ownership
    if (importData.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Import access denied");
    }
    // Verify it's a draft
    if (importData.status !== "draft") {
        throw new createCallable_1.HttpsError("failed-precondition", "Cannot delete a completed import");
    }
    // Delete the CSV file from storage if it exists
    if (importData.csvStoragePath) {
        try {
            const bucket = (0, storage_1.getStorage)().bucket();
            await bucket.file(importData.csvStoragePath).delete();
            console.log(`[deleteDraftImport] Deleted CSV file ${importData.csvStoragePath}`);
        }
        catch (error) {
            // Log but don't fail if file doesn't exist
            console.warn(`[deleteDraftImport] Could not delete CSV file: ${error}`);
        }
    }
    // Delete the import record
    await importRef.delete();
    console.log(`[deleteDraftImport] Deleted draft import ${importId}`, {
        userId: ctx.userId,
        sourceId: importData.sourceId,
    });
    return { success: true };
});
//# sourceMappingURL=deleteDraftImport.js.map