"use strict";
/**
 * Check if user has remaining transaction quota for the current month.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTransactionQuota = checkTransactionQuota;
exports.incrementTransactionCount = incrementTransactionCount;
const firestore_1 = require("firebase-admin/firestore");
const config_1 = require("./config");
async function checkTransactionQuota(userId, countToAdd = 1, isAdmin = false) {
    if (isAdmin) {
        return { allowed: true, currentCount: 0, limit: Infinity, remainingSlots: Infinity };
    }
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
    // Admin override: free_plan users have unlimited quota
    if (sub.adminOverride === "free_plan") {
        return { allowed: true, currentCount: 0, limit: Infinity, remainingSlots: Infinity };
    }
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
 * Also increments trialTransactionCount if user is on trial.
 */
async function incrementTransactionCount(userId, count) {
    const db = (0, firestore_1.getFirestore)();
    const subRef = db.collection("subscriptions").doc(userId);
    const subDoc = await subRef.get();
    if (!subDoc.exists)
        return;
    const sub = subDoc.data();
    const now = new Date();
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const countMonth = sub.transactionCountMonth || "";
    // Build the update
    const update = {
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    if (countMonth !== currentYearMonth) {
        update.transactionCountCurrentMonth = count;
        update.transactionCountMonth = currentYearMonth;
    }
    else {
        update.transactionCountCurrentMonth = firestore_1.FieldValue.increment(count);
    }
    // Also increment trial transaction count if on trial
    const trialStatus = (0, config_1.getTrialStatus)(sub);
    if (trialStatus.isOnTrial) {
        update.trialTransactionCount = firestore_1.FieldValue.increment(count);
    }
    await subRef.update(update);
}
//# sourceMappingURL=checkTransactionQuota.js.map