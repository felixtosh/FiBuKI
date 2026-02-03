/**
 * API Key Management for External Integrations
 *
 * Allows users to create API keys that can be used by external tools
 * (OpenClaw, Claude Desktop, etc.) to access their FiBuKI data.
 */

import { randomBytes, createHash } from "crypto";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

const API_KEYS_COLLECTION = "apiKeys";

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  keyHash: string; // SHA-256 hash of the key (we never store the raw key)
  keyPrefix: string; // First 8 chars for identification (e.g., "fk_abc123")
  scopes: string[]; // What the key can access
  lastUsedAt: Timestamp | null;
  usageCount: number;
  createdAt: Timestamp;
  expiresAt: Timestamp | null;
  revokedAt: Timestamp | null;
}

/**
 * Generate a secure API key
 * Format: fk_<32 random hex chars>
 */
function generateApiKey(): { key: string; hash: string; prefix: string } {
  const randomPart = randomBytes(16).toString("hex");
  const key = `fk_${randomPart}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.substring(0, 11); // "fk_" + first 8 chars
  return { key, hash, prefix };
}

/**
 * Hash an API key for lookup
 */
function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// ============================================================================
// Callable Functions (for UI)
// ============================================================================

interface CreateApiKeyRequest {
  name: string;
  scopes?: string[];
  expiresInDays?: number;
}

interface CreateApiKeyResponse {
  id: string;
  key: string; // Only returned once at creation!
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
}

/**
 * Create a new API key for the authenticated user
 */
export const createApiKeyCallable = createCallable<CreateApiKeyRequest, CreateApiKeyResponse>(
  { name: "createApiKey" },
  async (ctx, data) => {
    const { name, scopes = ["all"], expiresInDays } = data;

    if (!name || name.trim().length === 0) {
      throw new HttpsError("invalid-argument", "Name is required");
    }

    // Check existing key count (limit to 5 per user)
    const existingKeys = await ctx.db
      .collection(API_KEYS_COLLECTION)
      .where("userId", "==", ctx.userId)
      .where("revokedAt", "==", null)
      .get();

    if (existingKeys.size >= 5) {
      throw new HttpsError(
        "resource-exhausted",
        "Maximum 5 active API keys allowed. Revoke an existing key first."
      );
    }

    const { key, hash, prefix } = generateApiKey();
    const now = Timestamp.now();

    let expiresAt: Timestamp | null = null;
    if (expiresInDays && expiresInDays > 0) {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + expiresInDays);
      expiresAt = Timestamp.fromDate(expiryDate);
    }

    const docRef = ctx.db.collection(API_KEYS_COLLECTION).doc();
    const apiKeyData: Omit<ApiKey, "id"> = {
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
  }
);

interface ListApiKeysResponse {
  keys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    lastUsedAt: string | null;
    usageCount: number;
    createdAt: string;
    expiresAt: string | null;
  }>;
}

/**
 * List all API keys for the authenticated user
 */
export const listApiKeysCallable = createCallable<void, ListApiKeysResponse>(
  { name: "listApiKeys" },
  async (ctx) => {
    const snapshot = await ctx.db
      .collection(API_KEYS_COLLECTION)
      .where("userId", "==", ctx.userId)
      .where("revokedAt", "==", null)
      .orderBy("createdAt", "desc")
      .get();

    const keys = snapshot.docs.map((doc) => {
      const data = doc.data() as ApiKey;
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
  }
);

interface RevokeApiKeyRequest {
  keyId: string;
}

interface RevokeApiKeyResponse {
  success: boolean;
}

/**
 * Revoke an API key
 */
export const revokeApiKeyCallable = createCallable<RevokeApiKeyRequest, RevokeApiKeyResponse>(
  { name: "revokeApiKey" },
  async (ctx, data) => {
    const { keyId } = data;

    if (!keyId) {
      throw new HttpsError("invalid-argument", "keyId is required");
    }

    const docRef = ctx.db.collection(API_KEYS_COLLECTION).doc(keyId);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new HttpsError("not-found", "API key not found");
    }

    const keyData = doc.data() as ApiKey;
    if (keyData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Not your API key");
    }

    if (keyData.revokedAt) {
      throw new HttpsError("failed-precondition", "API key already revoked");
    }

    await docRef.update({
      revokedAt: Timestamp.now(),
    });

    return { success: true };
  }
);

// ============================================================================
// API Key Validation (for HTTP API)
// ============================================================================

export interface ValidatedApiKey {
  userId: string;
  keyId: string;
  scopes: string[];
}

/**
 * Validate an API key and return the associated user
 * Returns null if invalid
 */
export async function validateApiKey(key: string): Promise<ValidatedApiKey | null> {
  if (!key || !key.startsWith("fk_")) {
    return null;
  }

  const hash = hashApiKey(key);
  const db = getFirestore();

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
  const data = doc.data() as ApiKey;

  // Check expiry
  if (data.expiresAt && data.expiresAt.toDate() < new Date()) {
    return null;
  }

  // Update last used (non-blocking)
  doc.ref
    .update({
      lastUsedAt: Timestamp.now(),
      usageCount: FieldValue.increment(1),
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
