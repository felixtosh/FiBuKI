/**
 * OAuth HTTP endpoints, reached through the Next proxies on the public origin
 * (app/.well-known/oauth-*, app/api/oauth/*). Public clients only, so these are
 * unauthenticated by design: what they hand out is gated by the user's consent
 * (createOAuthAuthorization) and by PKCE, never by a header.
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  authorizationServerMetadata,
  OAuthRequestError,
  parseClientRegistration,
  protectedResourceMetadata,
} from "./oauthCore";
import {
  exchangeAuthorizationCode,
  refreshGrant,
  registerClient,
  buildClientRedirect,
  validateAuthorizeRequest,
  type AuthorizeParams,
} from "./oauthStore";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
};

interface Req {
  method: string;
  query: Record<string, unknown>;
  body?: unknown;
}
interface Res {
  set(headers: Record<string, string>): unknown;
  status(code: number): Res;
  json(body: unknown): unknown;
  end(): unknown;
}

const STATUS_FOR: Record<string, number> = {
  invalid_client: 401,
  server_error: 500,
};

function sendError(res: Res, error: unknown): void {
  if (error instanceof OAuthRequestError) {
    res.status(STATUS_FOR[error.code] ?? 400).json({ error: error.code, error_description: error.message });
    return;
  }
  console.error("[oauth] unexpected error", error);
  res.status(500).json({ error: "server_error" });
}

/** Wrap a handler: CORS, preflight, method check, error mapping. */
function endpoint(method: "GET" | "POST", handler: (req: Req, res: Res) => Promise<void>) {
  return onRequest({ region: "europe-west1" }, async (rawReq, rawRes) => {
    const req = rawReq as unknown as Req;
    const res = rawRes as unknown as Res;
    res.set(CORS);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (req.method !== method) {
      res.set({ Allow: method });
      res.status(405).json({ error: "invalid_request", error_description: `Use ${method}` });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  });
}

/** RFC 8414 / RFC 9728 documents. One function, so the issuer and resource cannot disagree. */
export const oauthMetadata = endpoint("GET", async (req, res) => {
  res.set({ "Cache-Control": "public, max-age=300" });
  switch (req.query.doc) {
    case "authorization-server":
      res.status(200).json(authorizationServerMetadata());
      return;
    case "protected-resource":
      res.status(200).json(protectedResourceMetadata());
      return;
    default:
      res.status(404).json({ error: "not_found" });
  }
});

/** RFC 7591 dynamic client registration. Open, because ChatGPT and Claude register themselves. */
export const oauthRegister = endpoint("POST", async (req, res) => {
  const registration = parseClientRegistration(req.body);
  const client = await registerClient(getFirestore(), registration);
  res.status(201).json({
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

/** RFC 6749 token endpoint: authorization_code and refresh_token, form or JSON body. */
export const oauthToken = endpoint("POST", async (req, res) => {
  res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const db = getFirestore();

  switch (body.grant_type) {
    case "authorization_code":
      res.status(200).json(
        await exchangeAuthorizationCode(db, {
          code: body.code,
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
          resource: body.resource,
        })
      );
      return;
    case "refresh_token":
      res.status(200).json(await refreshGrant(db, { refreshToken: body.refresh_token, clientId: body.client_id }));
      return;
    default:
      throw new OAuthRequestError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }
});

/** What the authorize page needs before it shows anything: is this request valid, and who is asking? */
export const oauthClientInfo = endpoint("GET", async (req, res) => {
  res.set({ "Cache-Control": "no-store" });
  const q = req.query;
  const params: AuthorizeParams = {
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    responseType: q.response_type,
    scope: q.scope,
    state: q.state,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
    resource: q.resource,
  };
  try {
    const request = await validateAuthorizeRequest(getFirestore(), params);
    res.status(200).json({
      valid: true,
      clientName: request.client.clientName,
      redirectHost: request.app.host,
      verified: request.app.verified,
      app: request.app.origin,
      scope: request.scope,
    });
  } catch (error) {
    if (!(error instanceof OAuthRequestError)) throw error;
    // A redirectable error goes back to the app, which is where the user's flow belongs.
    // The client and redirect URI were already validated by the time one is raised.
    const redirectUrl = error.redirectable && typeof q.redirect_uri === "string"
      ? buildClientRedirect(q.redirect_uri, { error: error.code, description: error.message }, typeof q.state === "string" ? q.state : undefined)
      : undefined;
    res.status(200).json({ valid: false, error: error.code, description: error.message, redirectUrl });
  }
});
