"use strict";
/**
 * Admin-only: Bulk refund all backers for a country that didn't reach its goal.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundCountryBackersCallable = void 0;
const stripe_1 = __importDefault(require("stripe"));
const params_1 = require("firebase-functions/params");
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
const stripeSecretKey = (0, params_1.defineSecret)("STRIPE_SECRET_KEY");
exports.refundCountryBackersCallable = (0, createCallable_1.createCallable)({
    name: "refundCountryBackers",
    secrets: [stripeSecretKey],
    timeoutSeconds: 300, // Bulk refunds may take a while
}, async (ctx, request) => {
    const { countryCode } = request;
    if (!countryCode) {
        throw new createCallable_1.HttpsError("invalid-argument", "countryCode is required");
    }
    // Admin check
    const isAdmin = ctx.request.auth?.token?.admin === true;
    const isSuperAdmin = ctx.request.auth?.token?.email === "felix@i7v6.com";
    if (!isAdmin && !isSuperAdmin) {
        throw new createCallable_1.HttpsError("permission-denied", "Admin access required");
    }
    const countryRef = ctx.db.collection("countryExpansion").doc(countryCode);
    const countryDoc = await countryRef.get();
    if (!countryDoc.exists) {
        throw new createCallable_1.HttpsError("not-found", `Country ${countryCode} not found`);
    }
    // Get all paid backers
    const backersSnap = await ctx.db
        .collection("countryBackers")
        .where("countryCode", "==", countryCode)
        .where("status", "==", "paid")
        .get();
    if (backersSnap.empty) {
        return { success: true, refundedCount: 0 };
    }
    const stripe = new stripe_1.default(stripeSecretKey.value());
    let refundedCount = 0;
    for (const backerDoc of backersSnap.docs) {
        const backer = backerDoc.data();
        try {
            await stripe.refunds.create({
                payment_intent: backer.stripePaymentIntentId,
            });
            await backerDoc.ref.update({
                status: "refunded",
                refundedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            refundedCount++;
        }
        catch (err) {
            console.error(`[refundCountryBackers] Failed to refund ${backerDoc.id}:`, err);
            // Continue with other refunds
        }
    }
    // Update country counters
    await countryRef.update({
        currentBackers: 0,
        totalCommitted: 0,
        status: "coming_soon",
    });
    console.log(`[refundCountryBackers] ${countryCode}: ${refundedCount}/${backersSnap.size} refunded`);
    return { success: true, refundedCount };
});
//# sourceMappingURL=refundCountryBackers.js.map