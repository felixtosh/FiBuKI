export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { consumeOAuthState } from "@/lib/gmail/oauth-state";
import { EncryptionNotConfiguredError, saveFolderIntegration } from "@/lib/folder-sync/connect-integration";

const PAGE = "/integrations/dropbox";
const REQUIRED_SCOPE = "files.content.read";

function redirectWithParams(request: NextRequest, params: Record<string, string>) {
  const url = new URL(PAGE, request.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = NextResponse.redirect(url);
  response.cookies.delete("dropbox_oauth_state");
  return response;
}

// Strip CR/LF so request-derived values cannot forge log lines
const clean = (v: unknown) => String(v).replace(/\n|\r/g, "");

/**
 * GET /api/dropbox/callback
 * Exchanges the code for a grant and creates (or re-activates) the Folder
 * Integration. The folder is chosen afterwards, on the integration page.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const error = sp.get("error");

  if (error) {
    console.error("[Dropbox OAuth] error from Dropbox:", clean(error));
    return redirectWithParams(request, { error: "access_denied" });
  }
  if (!code) return redirectWithParams(request, { error: "missing_code" });

  // The cookie proves the callback lands in the browser that started the flow.
  const stored = request.cookies.get("dropbox_oauth_state")?.value;
  if (!state || state !== stored) return redirectWithParams(request, { error: "invalid_state" });

  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const redirectUri =
    process.env.DROPBOX_OAUTH_REDIRECT_URI || "http://localhost:3000/api/dropbox/callback";
  if (!appKey || !appSecret) return redirectWithParams(request, { error: "oauth_not_configured" });

  // Who connected comes from the server-side record, never from the browser.
  const userId = await consumeOAuthState(state, "dropbox");
  if (!userId) return redirectWithParams(request, { error: "invalid_state" });

  try {
    const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: appKey,
        client_secret: appSecret,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      console.error("[Dropbox OAuth] token exchange failed:", clean(await tokenRes.text()));
      return redirectWithParams(request, { error: "token_exchange_failed" });
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      account_id?: string;
    };
    if (!tokens.access_token || !tokens.refresh_token) {
      return redirectWithParams(request, { error: "no_refresh_token" });
    }
    // Without content access the integration could list but never import.
    if (!(tokens.scope || "").split(/\s+/).includes(REQUIRED_SCOPE)) {
      return redirectWithParams(request, { error: "missing_scope" });
    }

    const acctRes = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!acctRes.ok) return redirectWithParams(request, { error: "account_lookup_failed" });
    const acct = (await acctRes.json()) as {
      account_id: string;
      email: string;
      name?: { display_name?: string };
    };

    const { integrationId } = await saveFolderIntegration({
      userId,
      provider: "dropbox",
      accountId: acct.account_id,
      accountEmail: acct.email,
      displayName: acct.name?.display_name,
      refreshToken: tokens.refresh_token,
    });

    return redirectWithParams(request, { success: "connected", integrationId });
  } catch (e) {
    if (e instanceof EncryptionNotConfiguredError) {
      console.error("[Dropbox OAuth] cannot encrypt the grant");
      return redirectWithParams(request, { error: "encryption_not_configured" });
    }
    console.error("[Dropbox OAuth] callback failed:", clean(e));
    return redirectWithParams(request, { error: "callback_failed" });
  }
}
