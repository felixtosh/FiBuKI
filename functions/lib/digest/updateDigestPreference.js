"use strict";
/**
 * Unified email preference callable.
 * Supports toggling digest and budget warning emails.
 * Also exports legacy `updateDigestPreferenceCallable` for backward compat during deploy window.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateDigestPreferenceCallable = exports.updateEmailPreferenceCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const PREFERENCE_FIELD = {
    digest: "digestEnabled",
    budgetWarnings: "budgetWarningsEnabled",
};
exports.updateEmailPreferenceCallable = (0, createCallable_1.createCallable)({ name: "updateEmailPreference" }, async (ctx, request) => {
    const { preference, enabled } = request;
    if (!PREFERENCE_FIELD[preference]) {
        throw new createCallable_1.HttpsError("invalid-argument", `preference must be one of: ${Object.keys(PREFERENCE_FIELD).join(", ")}`);
    }
    if (typeof enabled !== "boolean") {
        throw new createCallable_1.HttpsError("invalid-argument", "enabled must be a boolean");
    }
    const field = PREFERENCE_FIELD[preference];
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    await subRef.set({
        [field]: enabled,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { success: true };
});
exports.updateDigestPreferenceCallable = (0, createCallable_1.createCallable)({ name: "updateDigestPreference" }, async (ctx, request) => {
    if (typeof request.enabled !== "boolean") {
        throw new createCallable_1.HttpsError("invalid-argument", "enabled must be a boolean");
    }
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    await subRef.set({
        digestEnabled: request.enabled,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { success: true };
});
//# sourceMappingURL=updateDigestPreference.js.map