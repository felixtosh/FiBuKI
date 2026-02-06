"use strict";
/**
 * Learn billing cycle from partner's transaction date intervals.
 *
 * Algorithm:
 * 1. Query all transactions for a partner (limit 100, ordered by date)
 * 2. Compute inter-transaction intervals (days between consecutive transactions)
 * 3. Find the mode interval (most common, within +/- 5 day tolerance)
 * 4. If mode has 3+ occurrences and covers >50% of intervals → detected cycle
 * 5. Compute typical day-of-month from transaction dates
 * 6. If partner has files with extractedDate, compute invoice-to-transaction delay
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.learnBillingCycleCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const db = (0, firestore_1.getFirestore)();
exports.learnBillingCycleCallable = (0, createCallable_1.createCallable)({ name: "learnBillingCycle" }, async (ctx, request) => {
    const { partnerId } = request;
    if (!partnerId) {
        throw new createCallable_1.HttpsError("invalid-argument", "partnerId is required");
    }
    // Verify partner ownership
    const partnerRef = ctx.db.collection("partners").doc(partnerId);
    const partnerSnap = await partnerRef.get();
    if (!partnerSnap.exists || partnerSnap.data().userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("not-found", "Partner not found");
    }
    // Query transactions for this partner, ordered by date
    const txSnapshot = await ctx.db
        .collection("transactions")
        .where("userId", "==", ctx.userId)
        .where("partnerId", "==", partnerId)
        .orderBy("date", "asc")
        .limit(100)
        .get();
    if (txSnapshot.size < 3) {
        console.log(`[BillingCycle] Not enough transactions for partner ${partnerId}: ${txSnapshot.size}`);
        return { success: true, billingCycle: null };
    }
    // Compute dates and intervals
    const txDates = txSnapshot.docs.map((doc) => doc.data().date.toDate());
    const intervals = [];
    for (let i = 1; i < txDates.length; i++) {
        const daysDiff = Math.round((txDates[i].getTime() - txDates[i - 1].getTime()) / (1000 * 60 * 60 * 24));
        if (daysDiff > 0) {
            intervals.push(daysDiff);
        }
    }
    if (intervals.length < 2) {
        return { success: true, billingCycle: null };
    }
    // Find mode interval with +/- 5 day tolerance
    const result = findModeInterval(intervals, 5);
    if (!result) {
        console.log(`[BillingCycle] No consistent interval found for partner ${partnerId}`);
        return { success: true, billingCycle: null };
    }
    const { modeInterval, count, matchingIntervals } = result;
    // Require mode to have 3+ occurrences and cover >50% of intervals
    if (count < 3 || count / intervals.length < 0.5) {
        console.log(`[BillingCycle] Interval ${modeInterval}d not consistent enough: ` +
            `${count}/${intervals.length} (${Math.round(count / intervals.length * 100)}%)`);
        return { success: true, billingCycle: null };
    }
    // Compute frequency confidence based on consistency
    const consistencyRatio = count / intervals.length;
    const avgDeviation = matchingIntervals.reduce((sum, i) => sum + Math.abs(i - modeInterval), 0) /
        matchingIntervals.length;
    const frequencyConfidence = Math.min(100, Math.round(consistencyRatio * 80 + Math.max(0, 20 - avgDeviation * 2)));
    // Compute typical day-of-month
    const daysOfMonth = txDates.map((d) => d.getDate());
    const typicalDayOfMonth = computeMode(daysOfMonth);
    // Compute day variance (standard deviation of days-of-month)
    const dayMean = daysOfMonth.reduce((s, d) => s + d, 0) / daysOfMonth.length;
    const dayVariance = Math.round(Math.sqrt(daysOfMonth.reduce((s, d) => s + (d - dayMean) ** 2, 0) / daysOfMonth.length));
    // Compute invoice-to-transaction delay from file connections
    let invoiceToTransactionDelay;
    let delayVariance;
    try {
        const delays = await computeInvoiceDelays(ctx.userId, partnerId, txSnapshot.docs);
        if (delays.length >= 3) {
            invoiceToTransactionDelay = Math.round(delays.reduce((s, d) => s + d, 0) / delays.length);
            delayVariance = Math.round(Math.sqrt(delays.reduce((s, d) => s + (d - invoiceToTransactionDelay) ** 2, 0) / delays.length));
        }
    }
    catch (err) {
        console.warn("[BillingCycle] Failed to compute invoice delays:", err);
    }
    const billingCycle = {
        frequencyDays: modeInterval,
        frequencyConfidence,
        typicalDayOfMonth,
        dayVariance,
        invoiceToTransactionDelay,
        delayVariance,
        sampleSize: txSnapshot.size,
        updatedAt: firestore_1.Timestamp.now(),
    };
    // Store on partner
    await partnerRef.update({
        billingCycle,
        updatedAt: firestore_1.Timestamp.now(),
    });
    console.log(`[BillingCycle] Partner ${partnerId}: ${modeInterval}d cycle, ` +
        `${frequencyConfidence}% confidence, day=${typicalDayOfMonth}, ` +
        `delay=${invoiceToTransactionDelay ?? "N/A"}d, sample=${txSnapshot.size}`);
    return { success: true, billingCycle };
});
/**
 * Find the most common interval within tolerance.
 */
function findModeInterval(intervals, tolerance) {
    if (intervals.length === 0)
        return null;
    // Group intervals by buckets (using tolerance)
    let bestMode = 0;
    let bestCount = 0;
    let bestMatching = [];
    // Test each interval as a potential center
    const sorted = [...intervals].sort((a, b) => a - b);
    const tested = new Set();
    for (const center of sorted) {
        // Round to nearest 5 to avoid testing too many centers
        const rounded = Math.round(center / 5) * 5 || center;
        if (tested.has(rounded))
            continue;
        tested.add(rounded);
        const matching = intervals.filter((i) => Math.abs(i - rounded) <= tolerance);
        if (matching.length > bestCount) {
            bestCount = matching.length;
            bestMode = rounded;
            bestMatching = matching;
        }
    }
    // Also test common billing periods
    for (const period of [7, 14, 30, 60, 90, 180, 365]) {
        const matching = intervals.filter((i) => Math.abs(i - period) <= tolerance);
        if (matching.length >= bestCount) {
            bestCount = matching.length;
            bestMode = period;
            bestMatching = matching;
        }
    }
    if (bestCount === 0)
        return null;
    return { modeInterval: bestMode, count: bestCount, matchingIntervals: bestMatching };
}
/**
 * Compute the mode (most frequent value) of a number array.
 */
function computeMode(values) {
    const freq = new Map();
    for (const v of values) {
        freq.set(v, (freq.get(v) || 0) + 1);
    }
    let mode = values[0];
    let maxFreq = 0;
    for (const [val, count] of freq) {
        if (count > maxFreq) {
            maxFreq = count;
            mode = val;
        }
    }
    return mode;
}
/**
 * Compute invoice-to-transaction delays by matching file dates to transaction dates.
 */
async function computeInvoiceDelays(userId, partnerId, txDocs) {
    // Get file connections for these transactions
    const txIds = txDocs.map((d) => d.id);
    const delays = [];
    // Process in batches of 30 (Firestore 'in' limit)
    for (let i = 0; i < txIds.length; i += 30) {
        const batch = txIds.slice(i, i + 30);
        const connections = await db
            .collection("fileConnections")
            .where("transactionId", "in", batch)
            .where("userId", "==", userId)
            .get();
        if (connections.empty)
            continue;
        const fileIds = [...new Set(connections.docs.map((d) => d.data().fileId))];
        // Fetch files to get extractedDate
        for (let j = 0; j < fileIds.length; j += 30) {
            const fileBatch = fileIds.slice(j, j + 30);
            const files = await db
                .collection("files")
                .where("__name__", "in", fileBatch)
                .get();
            for (const fileDoc of files.docs) {
                const fileData = fileDoc.data();
                if (!fileData.extractedDate || fileData.partnerId !== partnerId)
                    continue;
                // Find the transaction this file is connected to
                const conn = connections.docs.find((c) => c.data().fileId === fileDoc.id);
                if (!conn)
                    continue;
                const tx = txDocs.find((t) => t.id === conn.data().transactionId);
                if (!tx)
                    continue;
                const txDate = tx.data().date.toDate();
                const fileDate = fileData.extractedDate.toDate();
                const delay = Math.round((txDate.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));
                delays.push(delay);
            }
        }
    }
    return delays;
}
//# sourceMappingURL=learnBillingCycle.js.map