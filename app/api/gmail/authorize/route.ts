export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { createOAuthState } from "@/lib/gmail/oauth-state";

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

  // The state is bound to the verified uid on the server (oauth-state.ts); the
  // callback takes the uid from that record, never from anything the browser
  // sends back. The cookie copy of the state remains as the CSRF check that
  // the callback lands in the browser that started the flow.
  const state = await createOAuthState(userId, "gmail");
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

  // CSRF state and optional return path for the callback. The uid is NOT put
  // in a cookie: a cookie is the user's to edit.
  response.cookies.set("gmail_oauth_state", state, cookieBase);
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    response.cookies.set("gmail_oauth_return_to", returnTo, cookieBase);
  }

  return response;
}
