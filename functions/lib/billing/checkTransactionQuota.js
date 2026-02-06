"use strict";
/**
 * Check if user has remaining transaction quota for the current month.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTransactionQuota = checkTransactionQuota;
exports.incrementTransactionCount = incrementTransactionCount;
const firestore_1 = require("firebase-admin/firestore");
const config_1 = require("./config");
async function checkTransactionQuota(userId, countToAdd = 1) {
    const db = (0, firestore_1.getFirestore)();
    const subRef = db.collection("subscriptions").doc(userId);
    const subDoc = await subRef.get();
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    if (!subDoc.exists) {
        // No subscription doc = free tier
        const freePlan = config_1.PLANS.free;
        return {
            allowed: countToAdd <= freePlan.transactionLimit,
            currentCount: 0,
            limit: freePlan.transactionLimit,
            remainingSlots: freePlan.transactionLimit,
        };
    }
    const sub = subDoc.data();
    const plan = (sub.plan || "free");
    const limit = config_1.PLANS[plan]?.transactionLimit ?? config_1.PLANS.free.transactionLimit;
    let currentCount = sub.transactionCountCurrentMonth || 0;
    const countMonth = sub.transactionCountMonth || "";
    // Reset if we're in a new month
    if (countMonth !== currentYearMonth) {
        currentCount = 0;
        await subRef.update({
            transactionCountCurrentMonth: 0,
            transactionCountMonth: currentYearMonth,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
    const remainingSlots = Math.max(0, limit - currentCount);
    return {
        allowed: countToAdd <= remainingSlots,
        currentCount,
        limit,
        remainingSlots,
    };
}
/**
 * Increment the transaction count after successful import.
 */
async function incrementTransactionCount(userId, count) {
    const db = (0, firestore_1.getFirestore)();
    const subRef = db.collection("subscriptions").doc(userId);
    const subDoc = await subRef.get();
    if (!subDoc.exists)
        return;
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const countMonth = subDoc.data().transactionCountMonth || "";
    if (countMonth !== currentYearMonth) {
        await subRef.update({
            transactionCountCurrentMonth: count,
            transactionCountMonth: currentYearMonth,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
    else {
        await subRef.update({
            transactionCountCurrentMonth: firestore_1.FieldValue.increment(count),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    }
}
//# sourceMappingURL=checkTransactionQuota.js.map