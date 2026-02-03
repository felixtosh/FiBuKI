"use strict";
/**
 * API Key Management for External Integrations
 *
 * Allows users to create API keys that can be used by external tools
 * (OpenClaw, Claude Desktop, etc.) to access their FiBuKI data.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.revokeApiKeyCallable = exports.listApiKeysCallable = exports.createApiKeyCallable = void 0;
exports.validateApiKey = validateApiKey;
const crypto_1 = require("crypto");
const firestore_1 = require("firebase-admin/firestore");
const createCallable_1 = require("../utils/createCallable");
const API_KEYS_COLLECTION = "apiKeys";
/**
 * Generate a secure API key
 * Format: fk_<32 random hex chars>
 */
function generateApiKey() {
    const randomPart = (0, crypto_1.randomBytes)(16).toString("hex");
    const key = `fk_${randomPart}`;
    const hash = (0, crypto_1.createHash)("sha256").update(key).digest("hex");
    const prefix = key.substring(0, 11); // "fk_" + first 8 chars
    return { key, hash, prefix };
}
/**
 * Hash an API key for lookup
 */
function hashApiKey(key) {
    return (0, crypto_1.createHash)("sha256").update(key).digest("hex");
}
/**
 * Create a new API key for the authenticated user
 */
exports.createApiKeyCallable = (0, createCallable_1.createCallable)({ name: "createApiKey" }, async (ctx, data) => {
    const { name, scopes = ["all"], expiresInDays } = data;
    if (!name || name.trim().length === 0) {
        throw new createCallable_1.HttpsError("invalid-argument", "Name is required");
    }
    // Check existing key count (limit to 5 per user)
    const existingKeys = await ctx.db
        .collection(API_KEYS_COLLECTION)
        .where("userId", "==", ctx.userId)
        .where("revokedAt", "==", null)
        .get();
    if (existingKeys.size >= 5) {
        throw new createCallable_1.HttpsError("resource-exhausted", "Maximum 5 active API keys allowed. Revoke an existing key first.");
    }
    const { key, hash, prefix } = generateApiKey();
    const now = firestore_1.Timestamp.now();
    let expiresAt = null;
    if (expiresInDays && expiresInDays > 0) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + expiresInDays);
        expiresAt = firestore_1.Timestamp.fromDate(expiryDate);
    }
    const docRef = ctx.db.collection(API_KEYS_COLLECTION).doc();
    const apiKeyData = {
        userId: ctx.userId,
        name: name.trim(),
        keyHash: hash,
        keyPrefix: prefix,
        scopes,
        lastUsedAt: null,
        usageCount: 0,
        createdAt: now,
        expiresAt,
        revokedAt: null,
    };
    await docRef.set(apiKeyData);
    return {
        id: docRef.id,
        key, // Only time the full key is returned!
        name: name.trim(),
        keyPrefix: prefix,
        scopes,
        expiresAt: expiresAt?.toDate().toISOString() || null,
    };
});
/**
 * List all API keys for the authenticated user
 */
exports.listApiKeysCallable = (0, createCallable_1.createCallable)({ name: "listApiKeys" }, async (ctx) => {
    const snapshot = await ctx.db
        .collection(API_KEYS_COLLECTION)
        .where("userId", "==", ctx.userId)
        .where("revokedAt", "==", null)
        .orderBy("createdAt", "desc")
        .get();
    const keys = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
            id: doc.id,
            name: data.name,
            keyPrefix: data.keyPrefix,
            scopes: data.scopes,
            lastUsedAt: data.lastUsedAt?.toDate().toISOString() || null,
            usageCount: data.usageCount,
            createdAt: data.createdAt.toDate().toISOString(),
            expiresAt: data.expiresAt?.toDate().toISOString() || null,
        };
    });
    return { keys };
});
/**
 * Revoke an API key
 */
exports.revokeApiKeyCallable = (0, createCallable_1.createCallable)({ name: "revokeApiKey" }, async (ctx, data) => {
    const { keyId } = data;
    if (!keyId) {
        throw new createCallable_1.HttpsError("invalid-argument", "keyId is required");
    }
    const docRef = ctx.db.collection(API_KEYS_COLLECTION).doc(keyId);
    const doc = await docRef.get();
    if (!doc.exists) {
        throw new createCallable_1.HttpsError("not-found", "API key not found");
    }
    const keyData = doc.data();
    if (keyData.userId !== ctx.userId) {
        throw new createCallable_1.HttpsError("permission-denied", "Not your API key");
    }
    if (keyData.revokedAt) {
        throw new createCallable_1.HttpsError("failed-precondition", "API key already revoked");
    }
    await docRef.update({
        revokedAt: firestore_1.Timestamp.now(),
    });
    return { success: true };
});
/**
 * Validate an API key and return the associated user
 * Returns null if invalid
 */
async function validateApiKey(key) {
    if (!key || !key.startsWith("fk_")) {
        return null;
    }
    const hash = hashApiKey(key);
    const db = (0, firestore_1.getFirestore)();
    const snapshot = await db
        .collection(API_KEYS_COLLECTION)
        .where("keyHash", "==", hash)
        .where("revokedAt", "==", null)
        .limit(1)
        .get();
    if (snapshot.empty) {
        return null;
    }
    const doc = snapshot.docs[0];
    const data = doc.data();
    // Check expiry
    if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
        return null;
    }
    // Update last used (non-blocking)
    doc.ref
        .update({
        lastUsedAt: firestore_1.Timestamp.now(),
        usageCount: firestore_1.FieldValue.increment(1),
    })
        .catch(() => {
        // Ignore update errors
    });
    return {
        userId: data.userId,
        keyId: doc.id,
        scopes: data.scopes,
    };
}
//# sourceMappingURL=index.js.map