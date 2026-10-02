export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { consumeOAuthState } from "@/lib/gmail/oauth-state";
import { EncryptionNotConfiguredError, saveFolderIntegration } from "@/lib/folder-sync/connect-integration";

const PAGE = "/integrations/gdrive";
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

function redirectWithParams(request: NextRequest, params: Record<string, string>) {
  const url = new URL(PAGE, request.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = NextResponse.redirect(url);
  response.cookies.delete("gdrive_oauth_state");
  return response;
}

// Strip CR/LF so request-derived values cannot forge log lines
const clean = (v: unknown) => String(v).replace(/\n|\r/g, "");

/**
 * GET /api/gdrive/callback
 * Exchanges the code for a grant and creates (or re-activates) the Folder
 * Integration. The folder is chosen afterwards, on the integration page.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const error = sp.get("error");

  if (error) {
    console.error("[GDrive OAuth] error from Google:", clean(error));
    return redirectWithParams(request, { error: "access_denied" });
  }
  if (!code) return redirectWithParams(request, { error: "missing_code" });

  // The cookie proves the callback lands in the browser that started the flow.
  const stored = request.cookies.get("gdrive_oauth_state")?.value;
  if (!state || state !== stored) return redirectWithParams(request, { error: "invalid_state" });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GDRIVE_OAUTH_REDIRECT_URI || "http://localhost:3000/api/gdrive/callback";
  if (!clientId || !clientSecret) return redirectWithParams(request, { error: "oauth_not_configured" });

  // Who connected comes from the server-side record, never from the browser.
  const userId = await consumeOAuthState(state, "gdrive");
  if (!userId) return redirectWithParams(request, { error: "invalid_state" });

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      console.error("[GDrive OAuth] token exchange failed:", clean(await tokenRes.text()));
      return redirectWithParams(request, { error: "token_exchange_failed" });
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
    };
    if (!tokens.access_token || !tokens.refresh_token) {
      return redirectWithParams(request, { error: "no_refresh_token" });
    }
    // Google may grant fewer scopes than asked (the user can untick one).
    if (!(tokens.scope || "").split(/\s+/).includes(REQUIRED_SCOPE)) {
      return redirectWithParams(request, { error: "missing_scope" });
    }

    const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) return redirectWithParams(request, { error: "account_lookup_failed" });
    const info = (await infoRes.json()) as { id: string; email: string; name?: string };

    const { integrationId } = await saveFolderIntegration({
      userId,
      provider: "gdrive",
      accountId: info.id,
      accountEmail: info.email,
      displayName: info.name,
      refreshToken: tokens.refresh_token,
    });

    return redirectWithParams(request, { success: "connected", integrationId });
  } catch (e) {
    if (e instanceof EncryptionNotConfiguredError) {
      console.error("[GDrive OAuth] cannot encrypt the grant");
      return redirectWithParams(request, { error: "encryption_not_configured" });
    }
    console.error("[GDrive OAuth] callback failed:", clean(e));
    return redirectWithParams(request, { error: "callback_failed" });
  }
}
