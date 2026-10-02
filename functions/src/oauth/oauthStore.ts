/**
 * OAuth persistence and grants. Three collections, all server-only (data-policy.ts):
 *
 *   oauthClients  registered apps (dynamic registration)
 *   oauthCodes    one-time authorization codes, keyed by their hash
 *   apiKeys       the grants themselves. An access token IS an API key (`fk_...`), so the MCP
 *                 endpoint, expiry, revocation and the "connected apps" list in Settings are one
 *                 mechanism. Extra oauth* fields on the document carry the refresh token.
 */

import { Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  appIdentityFor,
  generateAccessToken,
  isValidCodeChallenge,
  newClientId,
  normalizeScope,
  OAuthRequestError,
  webOrigin,
  randomToken,
  redirectUriMatches,
  REFRESH_TOKEN_TTL_SECONDS,
  resourceUrl,
  sha256Hex,
  verifyPkce,
  type AppIdentity,
  type ClientRegistration,
} from "./oauthCore";

const CLIENTS = "oauthClients";
const CODES = "oauthCodes";
const API_KEYS = "apiKeys";

export interface OAuthClient {
  id: string;
  clientName: string;
  redirectUris: string[];
}

export async function registerClient(db: Firestore, registration: ClientRegistration): Promise<OAuthClient> {
  const id = newClientId();
  await db.collection(CLIENTS).doc(id).set({
    clientName: registration.clientName,
    redirectUris: registration.redirectUris,
    createdAt: Timestamp.now(),
  });
  return { id, ...registration };
}

export async function getClient(db: Firestore, clientId: string): Promise<OAuthClient | null> {
  const snap = await db.collection(CLIENTS).doc(clientId).get();
  if (!snap.exists) return null;
  const data = snap.data() as { clientName: string; redirectUris: string[] };
  return { id: clientId, clientName: data.clientName, redirectUris: data.redirectUris };
}

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

export interface AuthorizeParams {
  clientId?: unknown;
  redirectUri?: unknown;
  responseType?: unknown;
  scope?: unknown;
  state?: unknown;
  codeChallenge?: unknown;
  codeChallengeMethod?: unknown;
  resource?: unknown;
}

export interface ValidAuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  scope: string;
  state: string | undefined;
  codeChallenge: string;
  resource: string;
  app: AppIdentity;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Check an authorization request. Errors about the client or the redirect URI are not
 * redirectable (sending them to an unverified URI would make us an open redirector);
 * every other error is.
 */
export async function validateAuthorizeRequest(
  db: Firestore,
  params: AuthorizeParams
): Promise<ValidAuthorizeRequest> {
  const clientId = str(params.clientId);
  const redirectUri = str(params.redirectUri);
  if (!clientId) throw new OAuthRequestError("invalid_request", "client_id is required");
  if (!redirectUri) throw new OAuthRequestError("invalid_request", "redirect_uri is required");

  const client = await getClient(db, clientId);
  if (!client) throw new OAuthRequestError("invalid_client", "Unknown client");
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    throw new OAuthRequestError("invalid_request", "redirect_uri is not registered for this client");
  }

  if (str(params.responseType) !== "code") {
    throw new OAuthRequestError("unsupported_response_type", "response_type must be code", true);
  }
  const challenge = params.codeChallenge;
  if (!isValidCodeChallenge(challenge) || str(params.codeChallengeMethod) !== "S256") {
    throw new OAuthRequestError("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256", true);
  }
  const scope = normalizeScope(params.scope);

  const resource = resourceUrl();
  const requestedResource = str(params.resource);
  if (requestedResource && requestedResource !== resource) {
    throw new OAuthRequestError("invalid_target", `resource must be ${resource}`, true);
  }

  return {
    client,
    redirectUri,
    scope,
    state: str(params.state),
    codeChallenge: challenge,
    resource,
    app: appIdentityFor(redirectUri),
  };
}

/** The URL to send the browser to: the code, or an error, plus state and iss (RFC 9207). */
export function buildClientRedirect(
  redirectUri: string,
  result: { code: string } | { error: string; description?: string },
  state?: string
): string {
  const url = new URL(redirectUri);
  if ("code" in result) {
    url.searchParams.set("code", result.code);
  } else {
    url.searchParams.set("error", result.error);
    if (result.description) url.searchParams.set("error_description", result.description);
  }
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", webOrigin());
  return url.toString();
}

export async function createAuthorizationCode(
  db: Firestore,
  userId: string,
  request: ValidAuthorizeRequest
): Promise<string> {
  const code = randomToken();
  const now = Date.now();
  await db.collection(CODES).doc(sha256Hex(code)).set({
    userId,
    clientId: request.client.id,
    redirectUri: request.redirectUri,
    scope: request.scope,
    codeChallenge: request.codeChallenge,
    resource: request.resource,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
    usedAt: null,
    grantKeyId: null,
  });
  return code;
}

// ---------------------------------------------------------------------------
// Grants and tokens
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string): TokenResponse {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

/** Everything that changes when a grant gets a new token pair. */
function tokenFields(now: number) {
  const access = generateAccessToken();
  const refreshToken = randomToken();
  return {
    accessToken: access.token,
    refreshToken,
    fields: {
      keyHash: access.hash,
      keyPrefix: access.prefix,
      expiresAt: Timestamp.fromMillis(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
      oauthRefreshHash: sha256Hex(refreshToken),
      oauthRefreshExpiresAt: Timestamp.fromMillis(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  };
}

async function issueNewGrant(
  db: Firestore,
  userId: string,
  client: OAuthClient,
  scope: string
): Promise<{ keyId: string; response: TokenResponse }> {
  const now = Date.now();
  const { accessToken, refreshToken, fields } = tokenFields(now);
  const ref = db.collection(API_KEYS).doc();
  await ref.set({
    userId,
    name: `${client.clientName} (connected app)`,
    // Same scope the user-created keys carry today: the whole account, through the tool surface.
    scopes: ["all"],
    lastUsedAt: null,
    usageCount: 0,
    createdAt: Timestamp.fromMillis(now),
    revokedAt: null,
    oauthClientId: client.id,
    oauthScope: scope,
    oauthPrevRefreshHash: null,
    ...fields,
  });
  return { keyId: ref.id, response: tokenResponse(accessToken, refreshToken, scope) };
}

export interface CodeExchange {
  code?: unknown;
  clientId?: unknown;
  redirectUri?: unknown;
  codeVerifier?: unknown;
  resource?: unknown;
}

export async function exchangeAuthorizationCode(db: Firestore, input: CodeExchange): Promise<TokenResponse> {
  const code = str(input.code);
  const clientId = str(input.clientId);
  if (!code || !clientId) throw new OAuthRequestError("invalid_request", "code and client_id are required");

  const client = await getClient(db, clientId);
  if (!client) throw new OAuthRequestError("invalid_client", "Unknown client");

  const ref = db.collection(CODES).doc(sha256Hex(code));
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { error: "invalid_grant" as const };
    const data = snap.data() as {
      userId: string;
      clientId: string;
      redirectUri: string;
      scope: string;
      codeChallenge: string;
      resource: string;
      expiresAt: Timestamp;
      usedAt: Timestamp | null;
      grantKeyId: string | null;
    };
    if (data.usedAt) return { error: "reused" as const, grantKeyId: data.grantKeyId };
    // The code is spent on the first attempt, right or wrong: a guess gets no second try.
    tx.set(ref, { ...data, usedAt: Timestamp.now() });
    return { data };
  });

  if ("error" in claimed) {
    // A code presented twice means it leaked: take back what the first use handed out.
    if (claimed.error === "reused" && claimed.grantKeyId) {
      await db.collection(API_KEYS).doc(claimed.grantKeyId).update({ revokedAt: Timestamp.now() });
    }
    throw new OAuthRequestError("invalid_grant", "The authorization code is invalid, expired or already used");
  }

  const { data } = claimed;
  if (
    data.clientId !== client.id ||
    data.expiresAt.toMillis() < Date.now() ||
    data.redirectUri !== str(input.redirectUri) ||
    !verifyPkce(input.codeVerifier, data.codeChallenge)
  ) {
    throw new OAuthRequestError("invalid_grant", "The authorization code is invalid, expired or already used");
  }
  const resource = str(input.resource);
  if (resource && resource !== data.resource) {
    throw new OAuthRequestError("invalid_target", `resource must be ${data.resource}`);
  }

  const { keyId, response } = await issueNewGrant(db, data.userId, client, data.scope);
  await ref.update({ grantKeyId: keyId });
  return response;
}

export interface RefreshExchange {
  refreshToken?: unknown;
  clientId?: unknown;
}

/**
 * Refresh: a new token pair on the same grant, the old refresh token spent. Presenting an
 * already-spent refresh token means it was copied, so the whole grant is revoked.
 */
export async function refreshGrant(db: Firestore, input: RefreshExchange): Promise<TokenResponse> {
  const refreshToken = str(input.refreshToken);
  const clientId = str(input.clientId);
  if (!refreshToken || !clientId) throw new OAuthRequestError("invalid_request", "refresh_token and client_id are required");

  const hash = sha256Hex(refreshToken);
  const current = await db.collection(API_KEYS).where("oauthRefreshHash", "==", hash).limit(1).get();

  if (current.empty) {
    const spent = await db.collection(API_KEYS).where("oauthPrevRefreshHash", "==", hash).limit(1).get();
    if (!spent.empty) await spent.docs[0].ref.update({ revokedAt: Timestamp.now() });
    throw new OAuthRequestError("invalid_grant", "The refresh token is invalid or expired");
  }

  const doc = current.docs[0];
  const grant = doc.data() as {
    revokedAt: Timestamp | null;
    oauthClientId: string;
    oauthScope: string;
    oauthRefreshExpiresAt: Timestamp;
  };
  if (grant.oauthClientId !== clientId || grant.revokedAt || grant.oauthRefreshExpiresAt.toMillis() < Date.now()) {
    throw new OAuthRequestError("invalid_grant", "The refresh token is invalid or expired");
  }

  const { accessToken, refreshToken: next, fields } = tokenFields(Date.now());
  await doc.ref.update({ ...fields, oauthPrevRefreshHash: hash });
  return tokenResponse(accessToken, next, grant.oauthScope);
}
