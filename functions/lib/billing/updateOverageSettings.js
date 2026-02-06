"use strict";
/**
 * Update overage settings for a user's subscription.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateOverageSettingsCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const config_1 = require("./config");
exports.updateOverageSettingsCallable = (0, createCallable_1.createCallable)({ name: "updateOverageSettings" }, async (ctx, request) => {
    const { overageCapEur } = request;
    if (typeof overageCapEur !== "number" || overageCapEur < 0 || overageCapEur > 200) {
        throw new createCallable_1.HttpsError("invalid-argument", "overageCapEur must be between 0 and 200");
    }
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    const subDoc = await subRef.get();
    if (!subDoc.exists) {
        throw new createCallable_1.HttpsError("not-found", "No subscription found");
    }
    const sub = subDoc.data();
    const plan = (sub.plan || "free");
    if (!config_1.PLANS[plan]?.overageAllowed) {
        throw new createCallable_1.HttpsError("failed-precondition", "Overage is not available on the free plan. Please upgrade to enable overage.");
    }
    // Check if we should un-pause AI
    let aiPaused = sub.aiPaused;
    if (aiPaused && overageCapEur > 0) {
        const currentOverage = sub.aiOverageCurrentPeriodEur || 0;
        if (overageCapEur > currentOverage) {
            aiPaused = false; // Room available now
        }
    }
    await subRef.update({
        aiOverageCapEur: overageCapEur,
        aiPaused,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    });
    return { success: true, aiPaused };
});
//# sourceMappingURL=updateOverageSettings.js.map