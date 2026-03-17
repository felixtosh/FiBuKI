"use strict";
/**
 * Admin-only: Activate a country after it reaches its backer threshold.
 * Sets status to "active" and sends notification emails to all backers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.activateCountryCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const firestore_1 = require("firebase-admin/firestore");
exports.activateCountryCallable = (0, createCallable_1.createCallable)({ name: "activateCountry" }, async (ctx, request) => {
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
    const countryData = countryDoc.data();
    if (countryData.status === "active") {
        throw new createCallable_1.HttpsError("already-exists", "Country is already active");
    }
    // Update country status
    await countryRef.update({
        status: "active",
        activatedAt: firestore_1.FieldValue.serverTimestamp(),
    });
    // Get all backers for this country
    const backersSnap = await ctx.db
        .collection("countryBackers")
        .where("countryCode", "==", countryCode)
        .where("status", "==", "paid")
        .get();
    // TODO: Send "Your country is live!" email to all backers via SendGrid
    // For now, log the backer emails
    const backerEmails = backersSnap.docs.map((d) => d.data().email);
    console.log(`[activateCountry] ${countryCode} activated. Backers to notify:`, backerEmails);
    return {
        success: true,
        backerCount: backersSnap.size,
    };
});
//# sourceMappingURL=activateCountry.js.map