"use strict";
/**
 * Get or create a referral code for the authenticated user.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReferralCodeCallable = void 0;
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
function generateCode(displayName) {
    const prefix = (displayName || "")
        .replace(/[^a-zA-Z]/g, "")
        .toUpperCase()
        .slice(0, 4);
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix || "REF"}${random}`.slice(0, 8);
}
exports.getReferralCodeCallable = (0, createCallable_1.createCallable)({ name: "getReferralCode" }, async (ctx) => {
    // Check if user already has a referral code
    const existing = await ctx.db
        .collection("referrals")
        .where("userId", "==", ctx.userId)
        .limit(1)
        .get();
    if (!existing.empty) {
        const doc = existing.docs[0];
        const code = doc.id;
        return { code, shareUrl: `https://fibuki.com/r/${code}` };
    }
    // Get user display name for code prefix
    const user = await (0, auth_1.getAuth)().getUser(ctx.userId);
    let code = generateCode(user.displayName || undefined);
    // Ensure code is unique (retry if collision)
    let attempts = 0;
    while (attempts < 5) {
        const existing = await ctx.db.collection("referrals").doc(code).get();
        if (!existing.exists)
            break;
        code = generateCode(user.displayName || undefined);
        attempts++;
    }
    // Create referral doc (doc ID = code for fast lookups)
    await ctx.db.collection("referrals").doc(code).set({
        code,
        userId: ctx.userId,
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    });
    return { code, shareUrl: `https://fibuki.com/r/${code}` };
});
//# sourceMappingURL=getReferralCode.js.map