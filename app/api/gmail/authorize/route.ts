export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";

/**
 * Gmail OAuth 2.0 scopes
 * - gmail.readonly: Read all emails and attachments
 * - userinfo.email: Get user's email address
 * - userinfo.profile: Get user's display name
 */
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * POST /api/gmail/authorize
 * Initiate OAuth 2.0 authorization code flow.
 *
 * SECURITY: the user id is derived from the verified Firebase ID token
 * (Authorization: Bearer ...), never from a client-supplied parameter. Callers
 * must be authenticated. Returns the Google consent URL as JSON for the client
 * to navigate to, and sets the httpOnly cookies (CSRF state, verified user id,
 * optional returnTo) that the callback consumes.
 */
export async function POST(request: NextRequest) {
  let userId: string;
  try {
    userId = await getServerUserIdWithFallback(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Google OAuth is not configured. Missing GOOGLE_CLIENT_ID." },
      { status: 500 }
    );
  }
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    "http://localhost:3000/api/gmail/callback";

  const body = await request.json().catch(() => ({}));
  const returnTo = typeof body?.returnTo === "string" ? body.returnTo : null;

  // Generate state parameter for CSRF protection
  const state = crypto.randomBytes(32).toString("hex");
  const stateExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline", // Required to get refresh token
    prompt: "consent", // Force consent to ensure refresh token is returned
    state,
  });

  const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  const response = NextResponse.json({ url: authUrl });

  const cookieBase = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    expires: stateExpiry,
    path: "/",
  };

  // CSRF state, verified user id, and optional return path for the callback.
  response.cookies.set("gmail_oauth_state", state, cookieBase);
  response.cookies.set("gmail_oauth_user_id", userId, cookieBase);
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    response.cookies.set("gmail_oauth_return_to", returnTo, cookieBase);
  }

  return response;
}
