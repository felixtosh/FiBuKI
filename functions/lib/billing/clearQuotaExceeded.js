"use strict";
/**
 * Clear quotaExceeded flag on all transactions for a user.
 *
 * Called when a user upgrades, gets a plan override, or switches
 * tester plans — so previously greyed-out transactions become active.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearQuotaExceeded = clearQuotaExceeded;
const firestore_1 = require("firebase-admin/firestore");
const BATCH_SIZE = 500;
async function clearQuotaExceeded(userId) {
    const db = (0, firestore_1.getFirestore)();
    const query = db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("quotaExceeded", "==", true);
    const snapshot = await query.get();
    if (snapshot.empty)
        return 0;
    let cleared = 0;
    for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
        const chunk = snapshot.docs.slice(i, i + BATCH_SIZE);
        const batch = db.batch();
        for (const doc of chunk) {
            batch.update(doc.ref, { quotaExceeded: false });
            cleared++;
        }
        await batch.commit();
    }
    console.log(`[clearQuotaExceeded] Cleared ${cleared} transactions for user ${userId}`);
    return cleared;
}
//# sourceMappingURL=clearQuotaExceeded.js.map