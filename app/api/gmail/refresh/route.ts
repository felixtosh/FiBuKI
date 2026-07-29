export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { decrypt, getEncryptionKey } from "@/lib/crypto/encryption";

const db = getAdminDb();
const TOKENS_COLLECTION = "emailTokens";
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  // Note: refresh_token is NOT returned when refreshing
}

/**
 * POST /api/gmail/refresh
 * Refresh access token using refresh token
 *
 * Body: { integrationId: string }
 * Returns: { accessToken, expiresAt } or error
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { integrationId } = body;

    if (!integrationId) {
      return NextResponse.json(
        { error: "Missing integrationId" },
        { status: 400 }
      );
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: "Google OAuth is not configured" },
        { status: 500 }
      );
    }

    // Get stored tokens
    const tokenSnap = await db.collection(TOKENS_COLLECTION).doc(integrationId).get();
    if (!tokenSnap.exists) {
      return NextResponse.json(
        { error: "Token not found" },
        { status: 404 }
      );
    }

    const tokenData = tokenSnap.data()!;
    let refreshToken = tokenData.refreshToken;

    if (!refreshToken) {
      // Mark integration as needing re-auth
      await db.collection(INTEGRATIONS_COLLECTION).doc(integrationId).update({
        needsReauth: true,
        lastError: "No refresh token available",
        updatedAt: Timestamp.now(),
      });

      return NextResponse.json(
        { error: "No refresh token available. User needs to re-authenticate." },
        { status: 401 }
      );
    }

    // Decrypt refresh token if it was stored encrypted
    if (tokenData.refreshTokenIv) {
      try {
        const encryptionKey = getEncryptionKey();
        refreshToken = decrypt(refreshToken, tokenData.refreshTokenIv, encryptionKey);
      } catch (decryptError) {
        console.error("Failed to decrypt refresh token:", decryptError);
        await db.collection(INTEGRATIONS_COLLECTION).doc(integrationId).update({
          needsReauth: true,
          lastError: "Failed to decrypt refresh token",
          updatedAt: Timestamp.now(),
        });
        return NextResponse.json(
          { error: "Failed to decrypt refresh token. User needs to re-authenticate." },
          { status: 401 }
        );
      }
    }

    // Refresh the token
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Token refresh failed:", errorData);

      // Check if refresh token is invalid/expired
      if (tokenResponse.status === 400 || tokenResponse.status === 401) {
        await db.collection(INTEGRATIONS_COLLECTION).doc(integrationId).update({
          needsReauth: true,
          lastError: "Refresh token expired or revoked",
          updatedAt: Timestamp.now(),
        });

        return NextResponse.json(
          { error: "Refresh token is invalid. User needs to re-authenticate." },
          { status: 401 }
        );
      }

      return NextResponse.json(
        { error: "Token refresh failed" },
        { status: 500 }
      );
    }

    const tokens: GoogleTokenResponse = await tokenResponse.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Update stored tokens
    await db.collection(TOKENS_COLLECTION).doc(integrationId).update({
      accessToken: tokens.access_token,
      expiresAt: Timestamp.fromDate(expiresAt),
      updatedAt: Timestamp.now(),
    });

    // Update integration
    await db.collection(INTEGRATIONS_COLLECTION).doc(integrationId).update({
      tokenExpiresAt: Timestamp.fromDate(expiresAt),
      needsReauth: false,
      lastError: null,
      updatedAt: Timestamp.now(),
    });

    console.log(`[Gmail OAuth] Refreshed token for integration ${sanitizeForLog(integrationId)}`);

    return NextResponse.json({
      success: true,
      accessToken: tokens.access_token,
      expiresAt: expiresAt.toISOString(),
    });

  } catch (error) {
    console.error("Token refresh error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Token refresh failed" },
      { status: 500 }
    );
  }
}
