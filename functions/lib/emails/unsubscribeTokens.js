"use strict";
/**
 * Shared HMAC token helpers for email unsubscribe links.
 * Used by digest and budget warning unsubscribe endpoints.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateUnsubscribeToken = generateUnsubscribeToken;
exports.verifyUnsubscribeToken = verifyUnsubscribeToken;
exports.buildUnsubscribeUrl = buildUnsubscribeUrl;
const crypto_1 = require("crypto");
const UNSUBSCRIBE_SECRET = process.env.DIGEST_HMAC_SECRET || "fibuki-digest-2026";
/**
 * Generate an HMAC token for a given userId + category.
 * The category is mixed into the HMAC so tokens are scoped per email type.
 */
function generateUnsubscribeToken(userId, category = "digest") {
    return (0, crypto_1.createHmac)("sha256", UNSUBSCRIBE_SECRET)
        .update(`${category}:${userId}`)
        .digest("hex");
}
/**
 * Verify an HMAC unsubscribe token (constant-time comparison).
 */
function verifyUnsubscribeToken(userId, token, category = "digest") {
    const expected = generateUnsubscribeToken(userId, category);
    if (expected.length !== token.length)
        return false;
    return (0, crypto_1.timingSafeEqual)(Buffer.from(expected), Buffer.from(token));
}
/**
 * Build a full unsubscribe URL for a given category.
 */
function buildUnsubscribeUrl(userId, category) {
    const token = generateUnsubscribeToken(userId, category);
    const endpoint = category === "digest" ? "unsubscribeDigest" : "unsubscribeBudgetWarnings";
    return `https://europe-west1-taxstudio-f12fb.cloudfunctions.net/${endpoint}?uid=${userId}&token=${token}`;
}
//# sourceMappingURL=unsubscribeTokens.js.map