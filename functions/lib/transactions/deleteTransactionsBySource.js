"use strict";
/**
 * Delete all transactions for a source (bank account)
 *
 * Used when deleting a source - all associated transactions must be deleted.
 * Individual transaction deletion is NOT allowed to maintain accounting integrity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTransactionsBySourceCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const BATCH_SIZE = 500; // Firestore batch limit
exports.deleteTransactionsBySourceCallable = (0, createCallable_1.createCallable)({
    name: "deleteTransactionsBySource",
    timeoutSeconds: 300, // Allow more time for large deletions
    memory: "512MiB",
}, async (ctx, request) => {
    const { sourceId } = request;
    if (!sourceId) {
        throw new createCallable_1.HttpsError("invalid-argument", "Source ID is required");
    }
    // Verify source ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();
    if (!sourceSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Source not found");
    }
    const sourceData = sourceSnap.data();
    if (sourceData?.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Access denied");
    }
    // Query all transactions for this source
    const transactionsQuery = ctx.db
        .collection("transactions")
        .where("userId", "==", ctx.userId)
        .where("sourceId", "==", sourceId);
    const snapshot = await transactionsQuery.get();
    if (snapshot.empty) {
        return { success: true, deleted: 0 };
    }
    let deleted = 0;
    // Delete file connections first, then transactions in batches
    for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
        const chunk = snapshot.docs.slice(i, i + BATCH_SIZE);
        // Delete file connections for each transaction
        for (const docSnap of chunk) {
            const connectionsQuery = ctx.db
                .collection("fileConnections")
                .where("transactionId", "==", docSnap.id);
            const connectionsSnap = await connectionsQuery.get();
            if (!connectionsSnap.empty) {
                const connectionsBatch = ctx.db.batch();
                for (const connDoc of connectionsSnap.docs) {
                    connectionsBatch.delete(connDoc.ref);
                }
                await connectionsBatch.commit();
            }
        }
        // Batch delete transactions
        const batch = ctx.db.batch();
        for (const docSnap of chunk) {
            batch.delete(docSnap.ref);
            deleted++;
        }
        await batch.commit();
    }
    // Decrement the transaction count (only non-quotaExceeded ones were counted)
    const withinQuotaCount = snapshot.docs.filter((d) => !d.data().quotaExceeded).length;
    if (withinQuotaCount > 0) {
        const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
        const subDoc = await subRef.get();
        if (subDoc.exists) {
            const current = subDoc.data().transactionCountCurrentMonth || 0;
            const newCount = Math.max(0, current - withinQuotaCount);
            await subRef.update({
                transactionCountCurrentMonth: newCount,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
    }
    console.log(`[deleteTransactionsBySource] Deleted ${deleted} transactions (${withinQuotaCount} counted toward quota)`, {
        userId: ctx.userId,
        sourceId,
    });
    return { success: true, deleted };
});
//# sourceMappingURL=deleteTransactionsBySource.js.map