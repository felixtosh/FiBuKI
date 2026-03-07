"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setOnboardingTrackCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
exports.setOnboardingTrackCallable = (0, createCallable_1.createCallable)({ name: "setOnboardingTrack" }, async (ctx, request) => {
    const { track } = request;
    if (track !== "data_only" && track !== "full_service") {
        throw new createCallable_1.HttpsError("invalid-argument", "track must be 'data_only' or 'full_service'");
    }
    const onboardingRef = ctx.db
        .collection("users")
        .doc(ctx.userId)
        .collection("settings")
        .doc("onboarding");
    // Set track on onboarding doc
    const firstStep = track === "data_only" ? "add_bank_account" : "set_identity";
    await onboardingRef.set({
        track,
        currentStep: firstStep,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    // Initialize trial on subscription doc
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    const subDoc = await subRef.get();
    if (subDoc.exists) {
        const sub = subDoc.data();
        // Only set trial if not already started and not already a paying customer
        if (!sub.trialStartedAt && !sub.stripeSubscriptionId) {
            const trialTier = track === "data_only" ? "data" : "smart";
            await subRef.update({
                trialTier,
                trialStartedAt: firestore_1.FieldValue.serverTimestamp(),
                trialTransactionCount: 0,
                trialExpired: false,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
    }
    return { success: true };
});
//# sourceMappingURL=setOnboardingTrackCallable.js.map