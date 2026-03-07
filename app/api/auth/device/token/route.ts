/**
 * POST /api/auth/device/token — Poll for device authorization approval
 *
 * Unauthenticated. The CLI polls this endpoint until the user approves.
 * Returns the API key on approval, or error codes while pending/expired.
 */

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import type { DeviceTokenResponse, DeviceCodeDoc } from "@/types/device-auth";

const COLLECTION = "deviceAuthCodes";
const MIN_POLL_INTERVAL_MS = 4000; // 4 seconds

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { device_code, grant_type } = body;

    if (grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Unsupported grant_type" } satisfies DeviceTokenResponse,
        { status: 400 }
      );
    }

    if (!device_code) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "device_code is required" } satisfies DeviceTokenResponse,
        { status: 400 }
      );
    }

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(device_code);
    const doc = await docRef.get();

    if (!doc.exists) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Unknown device_code" } satisfies DeviceTokenResponse,
        { status: 400 }
      );
    }

    const data = doc.data() as DeviceCodeDoc;

    // Check expiration
    if (data.expiresAt.toDate() < new Date()) {
      return NextResponse.json(
        { error: "expired_token", error_description: "Device code has expired. Start again." } satisfies DeviceTokenResponse,
        { status: 400 }
      );
    }

    // Enforce minimum poll interval
    if (data.lastPolledAt) {
      const elapsed = Date.now() - data.lastPolledAt.toDate().getTime();
      if (elapsed < MIN_POLL_INTERVAL_MS) {
        return NextResponse.json(
          { error: "slow_down", error_description: "Polling too fast. Wait 5 seconds." } satisfies DeviceTokenResponse,
          { status: 400 }
        );
      }
    }

    // Update lastPolledAt
    await docRef.update({ lastPolledAt: Timestamp.now() });

    if (data.status === "pending") {
      return NextResponse.json(
        { error: "authorization_pending", error_description: "User has not yet approved." } satisfies DeviceTokenResponse,
        { status: 400 }
      );
    }

    if (data.status === "approved" && data.apiKey) {
      // Return the key and delete the doc (consumed on retrieval)
      const response: DeviceTokenResponse = {
        access_token: data.apiKey,
        token_type: "Bearer",
        key_name: data.apiKeyName,
      };

      await docRef.delete();

      return NextResponse.json(response);
    }

    // Fallback: expired or invalid state
    return NextResponse.json(
      { error: "expired_token", error_description: "Device code is no longer valid." } satisfies DeviceTokenResponse,
      { status: 400 }
    );
  } catch (error) {
    console.error("[Device Auth] Token poll error:", error);
    return NextResponse.json(
      { error: "invalid_grant", error_description: "Internal server error" } satisfies DeviceTokenResponse,
      { status: 500 }
    );
  }
}
