"use strict";
/**
 * Compute account balance at a specific date.
 * Balance = openingBalance + sum(transactions from openingBalanceDate to targetDate)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBalanceAtDateCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
exports.getBalanceAtDateCallable = (0, createCallable_1.createCallable)({ name: "getBalanceAtDate" }, async (ctx, request) => {
    const { sourceId, date } = request;
    if (!sourceId) {
        throw new createCallable_1.HttpsError("invalid-argument", "sourceId is required");
    }
    if (!date) {
        throw new createCallable_1.HttpsError("invalid-argument", "date is required");
    }
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
        throw new createCallable_1.HttpsError("invalid-argument", "Invalid date format");
    }
    // Set to end of day
    targetDate.setHours(23, 59, 59, 999);
    // Verify ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();
    if (!sourceSnap.exists) {
        throw new createCallable_1.HttpsError("not-found", "Source not found");
    }
    const sourceData = sourceSnap.data();
    if (sourceData.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Access denied");
    }
    const openingBalance = sourceData.openingBalance ?? 0;
    const openingBalanceDate = sourceData.openingBalanceDate?.toDate();
    // Query transactions up to targetDate
    let query = ctx.db
        .collection("transactions")
        .where("userId", "==", ctx.userId)
        .where("sourceId", "==", sourceId)
        .where("date", "<=", firestore_1.Timestamp.fromDate(targetDate));
    // If we have an opening balance date, only sum transactions from that date onward
    if (openingBalanceDate) {
        query = query.where("date", ">=", firestore_1.Timestamp.fromDate(openingBalanceDate));
    }
    const snapshot = await query.get();
    let transactionSum = 0;
    for (const doc of snapshot.docs) {
        transactionSum += doc.data().amount ?? 0;
    }
    return {
        balance: openingBalance + transactionSum,
        openingBalance,
        transactionSum,
        transactionCount: snapshot.size,
        date,
        sourceId,
        sourceName: sourceData.name,
        currency: sourceData.currency || "EUR",
    };
});
//# sourceMappingURL=getBalanceAtDate.js.map