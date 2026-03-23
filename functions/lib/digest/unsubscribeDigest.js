"use strict";
/**
 * HTTP endpoint for one-click email unsubscribe (RFC 8058).
 * No auth required — uses HMAC token for verification.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.unsubscribeDigest = exports.generateUnsubscribeToken = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const unsubscribeTokens_1 = require("../emails/unsubscribeTokens");
Object.defineProperty(exports, "generateUnsubscribeToken", { enumerable: true, get: function () { return unsubscribeTokens_1.generateUnsubscribeToken; } });
exports.unsubscribeDigest = (0, https_1.onRequest)({
    region: "europe-west1",
    cors: false,
}, async (req, res) => {
    // Support both GET (link click) and POST (RFC 8058 one-click)
    if (req.method !== "GET" && req.method !== "POST") {
        res.status(405).send("Method Not Allowed");
        return;
    }
    const uid = (req.query.uid || req.body?.uid);
    const token = (req.query.token || req.body?.token);
    if (!uid || !token) {
        res.status(400).send("Missing parameters");
        return;
    }
    // Accept both new scoped tokens and legacy unscoped tokens
    const valid = (0, unsubscribeTokens_1.verifyUnsubscribeToken)(uid, token, "digest") ||
        verifyLegacyToken(uid, token);
    if (!valid) {
        res.status(403).send("Invalid token");
        return;
    }
    const db = (0, firestore_1.getFirestore)();
    await db.collection("subscriptions").doc(uid).set({ digestEnabled: false, updatedAt: firestore_1.FieldValue.serverTimestamp() }, { merge: true });
    // Return a simple confirmation page
    res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;display:flex;justify-content:center;align-items:center;min-height:100vh;">
  <div style="text-align:center;max-width:400px;padding:32px;">
    <h1 style="font-size:24px;margin:0 0 12px;">Unsubscribed</h1>
    <p style="color:#6b7280;margin:0 0 24px;">You won&rsquo;t receive weekly digest emails from FiBuKI anymore.</p>
    <p style="color:#9ca3af;font-size:14px;">You can re-enable digests anytime in <a href="https://fibuki.com/settings/notifications" style="color:#2563eb;">Settings</a>.</p>
  </div>
</body>
</html>`);
});
/**
 * Verify legacy unscoped tokens (generated before category-scoped tokens were introduced).
 */
function verifyLegacyToken(userId, token) {
    const { createHmac } = require("crypto");
    const secret = process.env.DIGEST_HMAC_SECRET || "fibuki-digest-2026";
    const expected = createHmac("sha256", secret).update(userId).digest("hex");
    if (expected.length !== token.length)
        return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
        result |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    }
    return result === 0;
}
//# sourceMappingURL=unsubscribeDigest.js.map