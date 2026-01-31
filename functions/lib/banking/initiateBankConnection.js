"use strict";
/**
 * Initiate a bank connection via finAPI
 *
 * This callable handles the full flow:
 * 1. Creates/authenticates finAPI user
 * 2. Creates web form for bank connection
 * 3. Stores connection metadata in Firestore
 *
 * Uses Firebase Secrets for finAPI credentials.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiateBankConnectionCallable = void 0;
const firestore_1 = require("firebase-admin/firestore");
const params_1 = require("firebase-functions/params");
const createCallable_1 = require("../utils/createCallable");
const FINAPI_CLIENT_ID = (0, params_1.defineSecret)("FINAPI_CLIENT_ID");
const FINAPI_CLIENT_SECRET = (0, params_1.defineSecret)("FINAPI_CLIENT_SECRET");
// finAPI base URL (sandbox for now)
const FINAPI_BASE_URL = "https://sandbox.finapi.io";
// Helper to generate deterministic password for finAPI user
function generateFinapiPassword(userId) {
    const secret = "fibuki-finapi-default-secret";
    const combined = `${secret}:${userId}`;
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
        const char = combined.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    let seed = Math.abs(hash);
    for (let i = 0; i < 20; i++) {
        password += chars.charAt(seed % chars.length);
        seed = Math.floor(seed / chars.length) + combined.charCodeAt(i % combined.length);
    }
    return password + "Aa1!";
}
exports.initiateBankConnectionCallable = (0, createCallable_1.createCallable)({
    name: "initiateBankConnection",
    secrets: [FINAPI_CLIENT_ID, FINAPI_CLIENT_SECRET],
    timeoutSeconds: 60,
}, async (ctx, request) => {
    const { institutionId, redirectUrl, maxHistoryDays, linkToSourceId, language } = request;
    if (!institutionId) {
        throw new createCallable_1.HttpsError("invalid-argument", "institutionId is required");
    }
    const clientId = FINAPI_CLIENT_ID.value();
    const clientSecret = FINAPI_CLIENT_SECRET.value();
    if (!clientId || !clientSecret) {
        throw new createCallable_1.HttpsError("failed-precondition", "finAPI credentials not configured");
    }
    // 1. Get client token
    const clientTokenRes = await fetch(`${FINAPI_BASE_URL}/api/v2/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });
    if (!clientTokenRes.ok) {
        const err = await clientTokenRes.text();
        console.error("[initiateBankConnection] Client token error:", err);
        throw new createCallable_1.HttpsError("unavailable", "Failed to authenticate with finAPI");
    }
    const clientTokenData = await clientTokenRes.json();
    const clientToken = clientTokenData.access_token;
    // 2. Create/authenticate finAPI user
    const finapiUserId = `fb_${ctx.userId.slice(0, 32)}`;
    const finapiPassword = generateFinapiPassword(finapiUserId);
    // Try to create user
    const createUserRes = await fetch(`${FINAPI_BASE_URL}/api/v2/users`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${clientToken}`,
        },
        body: JSON.stringify({
            id: finapiUserId,
            password: finapiPassword,
            email: `${ctx.userId}@fibuki.local`,
            isAutoUpdateEnabled: false,
        }),
    });
    if (!createUserRes.ok) {
        const errText = await createUserRes.text();
        // User might already exist - that's OK
        if (!errText.includes("already") && !errText.includes("exists") && !errText.includes("ENTITY_EXISTS")) {
            console.error("[initiateBankConnection] Create user error:", errText);
            // Don't throw - try to get token anyway
        }
    }
    // Get user token
    const userTokenRes = await fetch(`${FINAPI_BASE_URL}/api/v2/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "password",
            client_id: clientId,
            client_secret: clientSecret,
            username: finapiUserId,
            password: finapiPassword,
        }),
    });
    if (!userTokenRes.ok) {
        const err = await userTokenRes.text();
        console.error("[initiateBankConnection] User token error:", err);
        throw new createCallable_1.HttpsError("unavailable", "Failed to authenticate finAPI user");
    }
    const userTokenData = await userTokenRes.json();
    const userToken = userTokenData.access_token;
    const refreshToken = userTokenData.refresh_token || "";
    const tokenExpiresAt = new Date(Date.now() + userTokenData.expires_in * 1000);
    // 3. Get bank info
    const bankRes = await fetch(`${FINAPI_BASE_URL}/api/v2/banks/${institutionId}`, {
        headers: { "Authorization": `Bearer ${clientToken}` },
    });
    if (!bankRes.ok) {
        throw new createCallable_1.HttpsError("not-found", `Bank not found: ${institutionId}`);
    }
    const bank = await bankRes.json();
    // 4. Create web form for bank connection
    const isHttps = redirectUrl?.startsWith("https://");
    const webFormBody = {
        bank: { id: parseInt(institutionId, 10) },
        maxDaysForDownload: maxHistoryDays || 90,
        language: language || "de",
    };
    if (isHttps && redirectUrl) {
        webFormBody.redirectUrl = redirectUrl;
    }
    const webFormRes = await fetch(`${FINAPI_BASE_URL}/api/v2/webForms/bankConnectionImport`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${userToken}`,
        },
        body: JSON.stringify(webFormBody),
    });
    if (!webFormRes.ok) {
        const err = await webFormRes.text();
        console.error("[initiateBankConnection] Web form error:", err);
        throw new createCallable_1.HttpsError("unavailable", "Failed to create bank connection form");
    }
    const webForm = await webFormRes.json();
    // 5. Store connection in Firestore
    const now = firestore_1.Timestamp.now();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    const connectionDoc = {
        providerId: "finapi",
        providerConnectionId: webForm.id,
        institutionId: String(bank.id),
        institutionName: bank.name,
        institutionLogo: bank.logo?.url || null,
        status: "pending",
        authUrl: webForm.url,
        accountIds: [],
        expiresAt: firestore_1.Timestamp.fromDate(expiresAt),
        providerData: {
            finapiUserId,
            finapiPassword,
            userAccessToken: userToken,
            userRefreshToken: refreshToken,
            tokenExpiresAt: tokenExpiresAt.toISOString(),
            webFormToken: webForm.token,
        },
        linkToSourceId: linkToSourceId || null,
        userId: ctx.userId,
        createdAt: now,
        updatedAt: now,
    };
    const docRef = await ctx.db.collection("bankingConnections").add(connectionDoc);
    console.log(`[initiateBankConnection] Created connection ${docRef.id}`, {
        userId: ctx.userId,
        institutionId,
        institutionName: bank.name,
    });
    return {
        success: true,
        connectionId: docRef.id,
        authUrl: webForm.url,
        expiresAt: expiresAt.toISOString(),
    };
});
//# sourceMappingURL=initiateBankConnection.js.map