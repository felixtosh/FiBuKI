"use strict";
/**
 * Callable function to execute a validated import.
 * Requires explicit confirmation to wipe existing data.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeUserImportCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
exports.executeUserImportCallable = (0, createCallable_1.createCallable)({
    name: "executeUserImport",
    memory: "256MiB",
    timeoutSeconds: 60,
}, async (ctx, request) => {
    const { userId, db } = ctx;
    const { importId, confirmWipe } = request;
    if (!importId) {
        throw new createCallable_1.HttpsError("invalid-argument", "importId is required");
    }
    if (!confirmWipe) {
        throw new createCallable_1.HttpsError("failed-precondition", "Must confirm data wipe to proceed with import");
    }
    // Get the import record
    const importRef = db.collection("userImports").doc(importId);
    const importDoc = await importRef.get();
    if (!importDoc.exists) {
        throw new createCallable_1.HttpsError("not-found", "Import record not found");
    }
    const importData = importDoc.data();
    // Verify ownership
    if (importData?.userId !== userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Import does not belong to user");
    }
    // Verify status
    if (importData?.status !== "pending") {
        throw new createCallable_1.HttpsError("failed-precondition", `Cannot execute import with status: ${importData?.status}`);
    }
    // Verify validation passed
    if (!importData?.validation?.valid) {
        throw new createCallable_1.HttpsError("failed-precondition", "Import validation failed");
    }
    // Update status to trigger queue processor
    await importRef.update({
        status: "validating",
        startedAt: firestore_1.FieldValue.serverTimestamp(),
        "progress.phase": "validating",
    });
    console.log(`[executeUserImport] Started import ${importId} for user ${userId}`);
    return {
        success: true,
    };
});
//# sourceMappingURL=executeUserImport.js.map