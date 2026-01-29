"use strict";
/**
 * Callable function to initiate a user data export.
 * Creates a userExports document that triggers the queue processor.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestUserExportCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
const user_export_1 = require("../types/user-export");
exports.requestUserExportCallable = (0, createCallable_1.createCallable)({
    name: "requestUserExport",
    memory: "256MiB",
    timeoutSeconds: 60,
}, async (ctx, request) => {
    const { userId, db } = ctx;
    const { includeStorageFiles } = request;
    // Check if there's already a pending/processing export
    const existingExport = await db
        .collection("userExports")
        .where("userId", "==", userId)
        .where("status", "in", ["pending", "processing"])
        .limit(1)
        .get();
    if (!existingExport.empty) {
        // Return existing export ID
        const existingDoc = existingExport.docs[0];
        return {
            success: true,
            exportId: existingDoc.id,
        };
    }
    // Create new export document
    const exportRef = db.collection("userExports").doc();
    // Calculate expiry date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + user_export_1.EXPORT_EXPIRY_DAYS);
    const exportDoc = {
        userId,
        status: "pending",
        includeStorageFiles: includeStorageFiles ?? false,
        progress: {
            phase: "collecting",
            current: 0,
            total: 0,
        },
        counts: {
            sources: 0,
            transactions: 0,
            files: 0,
            partners: 0,
            categories: 0,
            noReceiptCategories: 0,
            fileConnections: 0,
        },
        retryCount: 0,
        maxRetries: 3,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    };
    await exportRef.set(exportDoc);
    console.log(`[requestUserExport] Created export ${exportRef.id} for user ${userId}`);
    return {
        success: true,
        exportId: exportRef.id,
    };
});
//# sourceMappingURL=requestUserExport.js.map