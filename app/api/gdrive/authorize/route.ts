export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { createOAuthState } from "@/lib/gmail/oauth-state";

/**
 * Read-only (ADR-0009). `drive.readonly` is a Google "restricted" scope: the
 * cloud deployment needs the OAuth app verified for it; a self-host that uses
 * its own Google project is not affected.
 */
export const GDRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * POST /api/gdrive/authorize
 * Starts the Google Drive OAuth flow and returns the consent URL as JSON.
 *
 * SECURITY: the user id comes from the verified session, never from the
 * request, and is bound to the OAuth state on the server.
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
    process.env.GDRIVE_OAUTH_REDIRECT_URI || "http://localhost:3000/api/gdrive/callback";

  const state = await createOAuthState(userId, "gdrive");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GDRIVE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // a refresh token is only returned on consent
    state,
  });

  const response = NextResponse.json({ url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
  response.cookies.set("gdrive_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: new Date(Date.now() + 10 * 60 * 1000),
    path: "/",
  });
  return response;
}
