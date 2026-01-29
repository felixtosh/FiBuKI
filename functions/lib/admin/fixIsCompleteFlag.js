"use strict";
/**
 * Migration callable to fix isComplete flag on existing transactions.
 * isComplete should be true when: fileIds.length > 0 OR noReceiptCategoryId is set
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fixIsCompleteFlagCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
exports.fixIsCompleteFlagCallable = (0, createCallable_1.createCallable)({ name: "fixIsCompleteFlag" }, async (ctx) => {
    // Query all user's transactions
    const snapshot = await ctx.db
        .collection("transactions")
        .where("userId", "==", ctx.userId)
        .get();
    let fixed = 0;
    let alreadyCorrect = 0;
    const batchSize = 500;
    let batch = ctx.db.batch();
    let batchCount = 0;
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const hasFiles = (data.fileIds?.length ?? 0) > 0;
        const hasCategory = !!data.noReceiptCategoryId;
        const shouldBeComplete = hasFiles || hasCategory;
        if (data.isComplete !== shouldBeComplete) {
            batch.update(doc.ref, { isComplete: shouldBeComplete });
            fixed++;
            batchCount++;
            // Firestore batch limit is 500
            if (batchCount >= batchSize) {
                await batch.commit();
                batch = ctx.db.batch();
                batchCount = 0;
            }
        }
        else {
            alreadyCorrect++;
        }
    }
    // Commit remaining
    if (batchCount > 0) {
        await batch.commit();
    }
    console.log(`[fixIsCompleteFlag] Fixed ${fixed} transactions, ${alreadyCorrect} already correct (total: ${snapshot.size})`);
    return {
        fixed,
        total: snapshot.size,
        alreadyCorrect,
    };
});
//# sourceMappingURL=fixIsCompleteFlag.js.map