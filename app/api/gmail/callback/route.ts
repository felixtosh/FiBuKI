export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { encrypt, getEncryptionKey } from "@/lib/crypto/encryption";

const db = getAdminDb();
const TOKENS_COLLECTION = "emailTokens";
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const USERS_COLLECTION = "users";
const FILES_COLLECTION = "files";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * GET /api/gmail/callback
 * Handle OAuth 2.0 callback from Google
 * Exchanges authorization code for tokens and creates integration
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  // Handle errors from Google
  if (error) {
    console.error("OAuth error from Google:", error);
    return redirectWithParams(request, "/integrations/gmail", { error });
  }

  // Verify required parameters
  if (!code) {
    return redirectWithParams(request, "/integrations/gmail", { error: "missing_code" });
  }

  // Verify state parameter (CSRF protection)
  const storedState = request.cookies.get("gmail_oauth_state")?.value;
  if (!state || state !== storedState) {
    console.error("OAuth state mismatch:", { state, storedState });
    return redirectWithParams(request, "/integrations/gmail", { error: "invalid_state" });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://localhost:3000/api/gmail/callback";

  if (!clientId || !clientSecret) {
    return redirectWithParams(request, "/integrations/gmail", { error: "oauth_not_configured" });
  }

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Token exchange failed:", errorData);
      return redirectWithParams(request, "/integrations/gmail", { error: "token_exchange_failed" });
    }

    const tokens: GoogleTokenResponse = await tokenResponse.json();

    if (!tokens.access_token) {
      console.error("No access token in response:", tokens);
      return redirectWithParams(request, "/integrations/gmail", { error: "no_access_token" });
    }

    // Google may grant fewer scopes than we requested (e.g. when our OAuth
    // verification for `gmail.readonly` lapses, or when the user unchecks it
    // on the consent screen). Without gmail.readonly the integration is
    // useless, so refuse the connection and surface a clear error rather
    // than silently storing a token that can only read userinfo.
    const grantedScopes = new Set((tokens.scope || "").split(/\s+/).filter(Boolean));
    if (!grantedScopes.has("https://www.googleapis.com/auth/gmail.readonly")) {
      console.error(
        "[Gmail OAuth] gmail.readonly NOT granted. Granted scopes:",
        tokens.scope,
      );
      return redirectWithParams(request, "/integrations/gmail", {
        error: "missing_gmail_scope",
      });
    }

    // Get user info
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      console.error("Failed to get user info");
      return redirectWithParams(request, "/integrations/gmail", { error: "userinfo_failed" });
    }

    const userInfo: GoogleUserInfo = await userInfoResponse.json();

    if (!userInfo.email) {
      return redirectWithParams(request, "/integrations/gmail", { error: "no_email" });
    }

    // Calculate token expiry
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Get userId from cookie set during auth start
    const cookieUserId = request.cookies.get("gmail_oauth_user_id")?.value;
    const userId = cookieUserId || "";
    if (!userId) {
      return redirectWithParams(request, "/integrations/gmail", { error: "no_user_id" });
    }

    // Check if email is already connected (active) using Admin SDK
    const existingQuery = await db
      .collection(INTEGRATIONS_COLLECTION)
      .where("userId", "==", userId)
      .where("email", "==", userInfo.email.toLowerCase())
      .where("isActive", "==", true)
      .get();

    if (!existingQuery.empty) {
      const existing = existingQuery.docs[0];
      // Update existing integration with new tokens
      await storeTokens(
        existing.id,
        tokens.access_token,
        tokens.refresh_token || "",
        expiresAt,
        userId
      );

      // Update token expiry on integration
      await db.collection(INTEGRATIONS_COLLECTION).doc(existing.id).update({
        tokenExpiresAt: Timestamp.fromDate(expiresAt),
        needsReauth: false,
        updatedAt: Timestamp.now(),
      });

      return redirectWithParams(request, "/integrations/gmail", { success: "tokens_updated" });
    }

    // Check for disconnected integration (reconnection)
    const disconnectedQuery = await db
      .collection(INTEGRATIONS_COLLECTION)
      .where("userId", "==", userId)
      .where("email", "==", userInfo.email.toLowerCase())
      .where("isActive", "==", false)
      .get();

    if (!disconnectedQuery.empty) {
      // Get the most recently disconnected one
      const sorted = disconnectedQuery.docs.sort((a, b) => {
        const aTime = a.data().disconnectedAt?.toMillis() || 0;
        const bTime = b.data().disconnectedAt?.toMillis() || 0;
        return bTime - aTime;
      });
      const disconnected = sorted[0];

      await storeTokens(
        disconnected.id,
        tokens.access_token,
        tokens.refresh_token || "",
        expiresAt,
        userId
      );

      // Reconnect the integration
      await db.collection(INTEGRATIONS_COLLECTION).doc(disconnected.id).update({
        isActive: true,
        disconnectedAt: null,
        needsReauth: false,
        lastError: null,
        tokenExpiresAt: Timestamp.fromDate(expiresAt),
        updatedAt: Timestamp.now(),
      });

      // Restore files for this integration
      const filesToRestore = await db
        .collection(FILES_COLLECTION)
        .where("userId", "==", userId)
        .where("integrationId", "==", disconnected.id)
        .where("isDeleted", "==", true)
        .get();

      let restored = 0;
      for (const fileDoc of filesToRestore.docs) {
        await fileDoc.ref.update({
          isDeleted: false,
          deletedAt: null,
          updatedAt: Timestamp.now(),
        });
        restored++;
      }

      console.log(`[Reconnect] Restored ${restored} files for ${userInfo.email}`);

      // Add email to user's own emails
      await addOwnEmail(userId, userInfo.email);

      return redirectWithParams(request, "/integrations/gmail", { success: "reconnected" });
    }

    // Create new integration
    const now = Timestamp.now();
    const newIntegrationRef = await db.collection(INTEGRATIONS_COLLECTION).add({
      userId,
      provider: "gmail",
      email: userInfo.email.toLowerCase(),
      displayName: userInfo.name || null,
      accountId: userInfo.id,
      tokenExpiresAt: Timestamp.fromDate(expiresAt),
      lastAccessedAt: null,
      isActive: true,
      needsReauth: false,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    // Store tokens securely
    await storeTokens(
      newIntegrationRef.id,
      tokens.access_token,
      tokens.refresh_token || "",
      expiresAt,
      userId
    );

    // Add email to user's own emails
    await addOwnEmail(userId, userInfo.email);

    console.log(`[Gmail OAuth] Created integration for ${userInfo.email} with refresh token: ${tokens.refresh_token ? "yes" : "no"}`);

    return redirectWithParams(request, "/integrations/gmail", { success: "connected" });

  } catch (error) {
    console.error("OAuth callback error:", error);
    return redirectWithParams(request, "/integrations/gmail", { error: String(error) });
  }
}

/**
 * Store tokens in secure server-side collection
 * Refresh tokens are encrypted with AES-256-GCM
 */
async function storeTokens(
  integrationId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date,
  userId: string
): Promise<void> {
  // Encrypt refresh token if present
  let encryptedRefreshToken = refreshToken;
  let refreshTokenIv: string | null = null;

  if (refreshToken) {
    try {
      const encryptionKey = getEncryptionKey();
      const { encrypted, iv } = encrypt(refreshToken, encryptionKey);
      encryptedRefreshToken = encrypted;
      refreshTokenIv = iv;
    } catch (error) {
      // Log but don't fail - encryption key might not be configured yet
      console.error("[Gmail OAuth] Failed to encrypt refresh token:", error);
      // Store unencrypted as fallback (will be encrypted on next refresh)
    }
  }

  await db.collection(TOKENS_COLLECTION).doc(integrationId).set({
    integrationId,
    userId,
    provider: "gmail",
    accessToken,
    refreshToken: encryptedRefreshToken,
    ...(refreshTokenIv && { refreshTokenIv }),
    expiresAt: Timestamp.fromDate(expiresAt),
    updatedAt: Timestamp.now(),
  });
}

/**
 * Add email to user's own emails list
 */
async function addOwnEmail(userId: string, email: string): Promise<void> {
  const userRef = db.collection(USERS_COLLECTION).doc(userId);
  const userDoc = await userRef.get();

  if (userDoc.exists) {
    await userRef.update({
      ownEmails: FieldValue.arrayUnion(email.toLowerCase()),
      updatedAt: Timestamp.now(),
    });
  } else {
    await userRef.set({
      ownEmails: [email.toLowerCase()],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  }
}

function getSafeReturnTo(request: NextRequest): string | null {
  const returnTo = request.cookies.get("gmail_oauth_return_to")?.value;
  if (!returnTo) return null;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return null;
  return returnTo;
}

function getBaseUrl(request: NextRequest): string {
  // In production, use the forwarded host or a hardcoded domain
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";

  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  // Fallback to host header
  const host = request.headers.get("host");
  if (host && !host.startsWith("0.0.0.0") && !host.startsWith("127.0.0.1")) {
    return `https://${host}`;
  }

  // Production fallback
  return "https://fibuki.com";
}

function redirectWithParams(
  request: NextRequest,
  fallbackPath: string,
  params: Record<string, string>
): NextResponse {
  const returnTo = getSafeReturnTo(request);
  const baseUrl = getBaseUrl(request);
  const url = new URL(returnTo || fallbackPath, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = NextResponse.redirect(url);
  response.cookies.delete("gmail_oauth_state");
  response.cookies.delete("gmail_oauth_return_to");
  response.cookies.delete("gmail_oauth_user_id");
  return response;
}
