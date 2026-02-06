"use strict";
/**
 * Dismiss a transaction suggestion from a file
 * Removes the suggestion from the file's transactionSuggestions array
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.dismissTransactionSuggestionCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
exports.dismissTransactionSuggestionCallable = (0, createCallable_1.createCallable)({ name: "dismissTransactionSuggestion" }, async (ctx, request) => {
    const { fileId, transactionId } = request;
    if (!fileId) {
        throw new createCallable_1.HttpsError("invalid-argument", "fileId is required");
    }
    if (!transactionId) {
        throw new createCallable_1.HttpsError("invalid-argument", "transactionId is required");
    }
    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();
    if (!fileSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "File not found");
    }
    const fileData = fileSnap.data();
    if (fileData.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Access denied");
    }
    // Filter out the dismissed suggestion and capture its confidence
    const currentSuggestions = (fileData.transactionSuggestions || []);
    const dismissedSuggestion = currentSuggestions.find((s) => s.transactionId === transactionId);
    const updatedSuggestions = currentSuggestions.filter((s) => s.transactionId !== transactionId);
    // Track dismissed suggestions to prevent them from being re-suggested
    // Write both legacy (string[]) and new (object[]) formats
    const dismissedSuggestions = (fileData.dismissedTransactionIds || []);
    if (!dismissedSuggestions.includes(transactionId)) {
        dismissedSuggestions.push(transactionId);
    }
    const updateData = {
        transactionSuggestions: updatedSuggestions,
        dismissedTransactionIds: dismissedSuggestions,
        dismissedTransactions: firestore_1.FieldValue.arrayUnion({
            transactionId,
            dismissedAt: firestore_1.Timestamp.now(),
            confidence: dismissedSuggestion?.confidence ?? null,
        }),
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    await fileRef.update(updateData);
    console.log(`[dismissTransactionSuggestion] Dismissed suggestion for file ${fileId}`, {
        userId: ctx.userId,
        transactionId,
    });
    return { success: true };
});
//# sourceMappingURL=dismissTransactionSuggestion.js.map