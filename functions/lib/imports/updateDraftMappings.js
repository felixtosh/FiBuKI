"use strict";
/**
 * Update field mappings on a draft import.
 * Called when user edits column mappings to persist their changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateDraftMappingsCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
exports.updateDraftMappingsCallable = (0, createCallable_1.createCallable)({ name: "updateDraftMappings" }, async (ctx, request) => {
    const { importId, fieldMappings } = request;
    if (!importId || !fieldMappings) {
        throw new createCallable_1.HttpsError("invalid-argument", "importId and fieldMappings are required");
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
    // Verify it's still a draft
    if (importData.status !== "draft") {
        throw new createCallable_1.HttpsError("failed-precondition", "Cannot update mappings on a completed import");
    }
    // Update the mappings
    await importRef.update({
        fieldMappings,
        updatedAt: firestore_1.Timestamp.now(),
    });
    console.log(`[updateDraftMappings] Updated mappings for ${importId}`, {
        userId: ctx.userId,
        mappingCount: fieldMappings.length,
    });
    return { success: true };
});
//# sourceMappingURL=updateDraftMappings.js.map