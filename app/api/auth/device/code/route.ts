/**
 * POST /api/auth/device/code — Initiate device authorization flow
 *
 * Unauthenticated. Generates a device_code + user_code pair.
 * The CLI displays the user_code and opens the browser for approval.
 */

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { randomUUID } from "crypto";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import type { DeviceCodeResponse } from "@/types/device-auth";

const COLLECTION = "deviceAuthCodes";
const CODE_TTL_SECONDS = 600; // 10 minutes
const MAX_PENDING_PER_IP = 10;

// Alphabet excluding ambiguous chars: 0, O, 1, I, L
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateUserCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    const idx = Math.floor(Math.random() * CODE_ALPHABET.length);
    chars.push(CODE_ALPHABET[idx]);
  }
  return chars.slice(0, 4).join("") + "-" + chars.slice(4).join("");
}

export async function POST(request: Request) {
  try {
    const db = getAdminDb();

    // Rate limit by IP
    const forwarded = request.headers.get("x-forwarded-for");
    const ipAddress = forwarded?.split(",")[0]?.trim() || "unknown";

    const oneHourAgo = Timestamp.fromDate(new Date(Date.now() - 60 * 60 * 1000));
    const pendingSnapshot = await db
      .collection(COLLECTION)
      .where("ipAddress", "==", ipAddress)
      .where("status", "==", "pending")
      .where("createdAt", ">=", oneHourAgo)
      .get();

    if (pendingSnapshot.size >= MAX_PENDING_PER_IP) {
      return NextResponse.json(
        { error: "Too many pending authorization requests. Try again later." },
        { status: 429 }
      );
    }

    const deviceCode = randomUUID();
    const userCode = generateUserCode();
    const now = Timestamp.now();
    const expiresAt = Timestamp.fromDate(new Date(Date.now() + CODE_TTL_SECONDS * 1000));

    await db.collection(COLLECTION).doc(deviceCode).set({
      deviceCode,
      userCode,
      status: "pending",
      ipAddress,
      createdAt: now,
      expiresAt,
    });

    const response: DeviceCodeResponse = {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: "https://fibuki.com/auth/device",
      expires_in: CODE_TTL_SECONDS,
      interval: 5,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[Device Auth] Code generation error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
