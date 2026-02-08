"use strict";
/**
 * Get account balances across all sources at a specific date.
 * Used for tax reporting (e.g. Kontostand 31.12.)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAccountBalancesCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
exports.getAccountBalancesCallable = (0, createCallable_1.createCallable)({ name: "getAccountBalances" }, async (ctx, request) => {
    const { date } = request;
    if (!date) {
        throw new createCallable_1.HttpsError("invalid-argument", "date is required");
    }
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
        throw new createCallable_1.HttpsError("invalid-argument", "Invalid date format");
    }
    // Set to end of day
    targetDate.setHours(23, 59, 59, 999);
    // Get all active sources for the user
    const sourcesSnap = await ctx.db
        .collection("sources")
        .where("userId", "==", ctx.userId)
        .where("isActive", "==", true)
        .get();
    const balances = [];
    for (const sourceDoc of sourcesSnap.docs) {
        const sourceData = sourceDoc.data();
        const openingBalance = sourceData.openingBalance ?? 0;
        const openingBalanceDate = sourceData.openingBalanceDate?.toDate();
        // Query transactions up to targetDate
        let query = ctx.db
            .collection("transactions")
            .where("userId", "==", ctx.userId)
            .where("sourceId", "==", sourceDoc.id)
            .where("date", "<=", firestore_1.Timestamp.fromDate(targetDate));
        if (openingBalanceDate) {
            query = query.where("date", ">=", firestore_1.Timestamp.fromDate(openingBalanceDate));
        }
        const txSnap = await query.get();
        let transactionSum = 0;
        for (const doc of txSnap.docs) {
            transactionSum += doc.data().amount ?? 0;
        }
        balances.push({
            sourceId: sourceDoc.id,
            sourceName: sourceData.name,
            currency: sourceData.currency || "EUR",
            accountKind: sourceData.accountKind || "bank_account",
            openingBalance,
            transactionSum,
            balanceAtDate: openingBalance + transactionSum,
        });
    }
    return { balances, date };
});
//# sourceMappingURL=getAccountBalances.js.map