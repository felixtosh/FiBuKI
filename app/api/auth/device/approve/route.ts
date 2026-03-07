/**
 * POST /api/auth/device/approve — Approve a device authorization (authenticated)
 *
 * Requires a valid Firebase Auth token. Creates an API key for the user
 * and stores it on the device code doc for the CLI to retrieve.
 */

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { Timestamp } from "firebase-admin/firestore";
import { randomBytes, createHash } from "crypto";

const DEVICE_COLLECTION = "deviceAuthCodes";
const API_KEYS_COLLECTION = "apiKeys";
const MAX_API_KEYS = 5;

function generateApiKey(): { key: string; hash: string; prefix: string } {
  const randomPart = randomBytes(16).toString("hex");
  const key = `fk_${randomPart}`;
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.substring(0, 11);
  return { key, hash, prefix };
}

export async function POST(request: Request) {
  try {
    // Authenticate the user
    let userId: string;
    try {
      userId = await getServerUserIdWithFallback(request);
    } catch {
      return NextResponse.json(
        { error: "Unauthorized. Please log in first." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { user_code } = body;

    if (!user_code || typeof user_code !== "string") {
      return NextResponse.json(
        { error: "user_code is required" },
        { status: 400 }
      );
    }

    const normalizedCode = user_code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalizedCode.length !== 8) {
      return NextResponse.json(
        { error: "Invalid code format. Expected 8 characters (e.g., ABCD-1234)." },
        { status: 400 }
      );
    }

    const formattedCode = normalizedCode.slice(0, 4) + "-" + normalizedCode.slice(4);

    const db = getAdminDb();

    // Find the pending device code
    const snapshot = await db
      .collection(DEVICE_COLLECTION)
      .where("userCode", "==", formattedCode)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (snapshot.empty) {
      return NextResponse.json(
        { error: "Invalid or expired code. Please check and try again." },
        { status: 404 }
      );
    }

    const deviceDoc = snapshot.docs[0];
    const deviceData = deviceDoc.data();

    // Check expiration
    if (deviceData.expiresAt.toDate() < new Date()) {
      return NextResponse.json(
        { error: "Code has expired. Please start the CLI auth process again." },
        { status: 410 }
      );
    }

    // Check API key limit
    const existingKeys = await db
      .collection(API_KEYS_COLLECTION)
      .where("userId", "==", userId)
      .where("revokedAt", "==", null)
      .get();

    if (existingKeys.size >= MAX_API_KEYS) {
      return NextResponse.json(
        { error: "Maximum 5 active API keys. Revoke an existing key in Settings > Integrations first." },
        { status: 409 }
      );
    }

    // Generate API key (same pattern as functions/src/api-keys/index.ts)
    const { key, hash, prefix } = generateApiKey();
    const now = Timestamp.now();
    const keyName = "CLI (Device Auth)";

    const keyDocRef = db.collection(API_KEYS_COLLECTION).doc();
    await keyDocRef.set({
      userId,
      name: keyName,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: ["all"],
      lastUsedAt: null,
      usageCount: 0,
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
    });

    // Mark device code as approved with the API key
    await deviceDoc.ref.update({
      status: "approved",
      apiKey: key,
      apiKeyName: keyName,
      userId,
    });

    return NextResponse.json({
      success: true,
      keyName,
    });
  } catch (error) {
    console.error("[Device Auth] Approve error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
