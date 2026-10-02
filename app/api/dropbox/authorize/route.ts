export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { createOAuthState } from "@/lib/gmail/oauth-state";

/**
 * Read-only scopes only (ADR-0009): FiBuKI lists and downloads, it never writes
 * to the user's Dropbox.
 */
export const DROPBOX_SCOPES = ["account_info.read", "files.metadata.read", "files.content.read"];

const DROPBOX_AUTH_URL = "https://www.dropbox.com/oauth2/authorize";

/**
 * POST /api/dropbox/authorize
 * Starts the Dropbox OAuth flow and returns the consent URL as JSON.
 *
 * SECURITY: the user id comes from the verified session, never from the
 * request, and is bound to the OAuth state on the server (oauth-state.ts); the
 * callback learns who connected from that record alone.
 */
export async function POST(request: NextRequest) {
  let userId: string;
  try {
    userId = await getServerUserIdWithFallback(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appKey = process.env.DROPBOX_APP_KEY;
  if (!appKey) {
    return NextResponse.json(
      { error: "Dropbox is not configured. Missing DROPBOX_APP_KEY." },
      { status: 500 }
    );
  }
  const redirectUri =
    process.env.DROPBOX_OAUTH_REDIRECT_URI || "http://localhost:3000/api/dropbox/callback";

  const state = await createOAuthState(userId, "dropbox");
  const expires = new Date(Date.now() + 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: appKey,
    redirect_uri: redirectUri,
    response_type: "code",
    token_access_type: "offline", // a refresh token
    scope: DROPBOX_SCOPES.join(" "),
    state,
  });

  const response = NextResponse.json({ url: `${DROPBOX_AUTH_URL}?${params.toString()}` });
  response.cookies.set("dropbox_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires,
    path: "/",
  });
  return response;
}
