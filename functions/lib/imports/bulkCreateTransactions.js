"use strict";
/**
 * Bulk create transactions from a CSV import
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bulkCreateTransactionsCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const checkTransactionQuota_1 = require("../billing/checkTransactionQuota");
const BATCH_SIZE = 500; // Firestore batch limit
exports.bulkCreateTransactionsCallable = (0, createCallable_1.createCallable)({
    name: "bulkCreateTransactions",
    timeoutSeconds: 300, // 5 minutes for large imports
    memory: "1GiB",
}, async (ctx, request) => {
    const { transactions, sourceId } = request;
    if (!transactions || !Array.isArray(transactions)) {
        throw new createCallable_1.HttpsError("invalid-argument", "transactions array is required");
    }
    if (!sourceId) {
        throw new createCallable_1.HttpsError("invalid-argument", "sourceId is required");
    }
    if (transactions.length === 0) {
        return { success: true, transactionIds: [], count: 0 };
    }
    if (transactions.length > 5000) {
        throw new createCallable_1.HttpsError("invalid-argument", "Cannot import more than 5000 transactions at once");
    }
    // Verify source ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();
    if (!sourceSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Source not found");
    }
    if (sourceSnap.data().userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Source access denied");
    }
    // Check transaction quota before importing
    const quota = await (0, checkTransactionQuota_1.checkTransactionQuota)(ctx.userId, transactions.length);
    if (!quota.allowed) {
        throw new createCallable_1.HttpsError("resource-exhausted", `Transaction limit reached. You have ${quota.remainingSlots} of ${quota.limit} slots remaining this month, ` +
            `but this import contains ${transactions.length} transactions. Please upgrade your plan.`);
    }
    const now = firestore_1.Timestamp.now();
    const transactionIds = [];
    // Process in batches
    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
        const batch = ctx.db.batch();
        const chunk = transactions.slice(i, i + BATCH_SIZE);
        for (const txData of chunk) {
            const docRef = ctx.db.collection("transactions").doc();
            transactionIds.push(docRef.id);
            // Convert ISO date string to Timestamp
            const date = new Date(txData.date);
            if (isNaN(date.getTime())) {
                throw new createCallable_1.HttpsError("invalid-argument", `Invalid date for transaction: ${txData.date}`);
            }
            const transactionDoc = {
                userId: ctx.userId,
                sourceId: txData.sourceId,
                date: firestore_1.Timestamp.fromDate(date),
                amount: txData.amount,
                currency: txData.currency,
                name: txData.name,
                description: txData.description ?? null,
                partner: txData.partner ?? null,
                reference: txData.reference ?? null,
                partnerIban: txData.partnerIban ?? null,
                dedupeHash: txData.dedupeHash,
                importJobId: txData.importJobId,
                csvRowIndex: txData.csvRowIndex,
                _original: txData._original,
                // Default values
                fileIds: [],
                isComplete: false,
                partnerId: null,
                partnerType: null,
                partnerMatchConfidence: null,
                partnerMatchedBy: null,
                noReceiptCategoryId: null,
                createdAt: now,
                updatedAt: now,
            };
            batch.set(docRef, transactionDoc);
        }
        await batch.commit();
    }
    console.log(`[bulkCreateTransactions] Created ${transactionIds.length} transactions`, {
        userId: ctx.userId,
        sourceId,
    });
    // Increment transaction count (non-blocking)
    (0, checkTransactionQuota_1.incrementTransactionCount)(ctx.userId, transactionIds.length).catch((err) => console.error("[bulkCreateTransactions] Failed to increment transaction count:", err));
    return {
        success: true,
        transactionIds,
        count: transactionIds.length,
    };
});
//# sourceMappingURL=bulkCreateTransactions.js.map