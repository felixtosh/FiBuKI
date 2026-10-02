/**
 * OAuth for connected apps (ChatGPT, Claude, Codex): the pure parts.
 *
 * FiBuKI is the authorization server and the MCP endpoint is the protected resource.
 * Public clients only (PKCE, no secret), dynamic client registration, authorization
 * code with refresh. No I/O in this file; oauthStore.ts persists, oauthHttp.ts serves.
 */

import { createHash, randomBytes } from "crypto";

export const OAUTH_SCOPE = "fibuki";
export const SUPPORTED_SCOPES = [OAUTH_SCOPE];

/** Access tokens are short; the refresh token carries the grant. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 100;

/** Path of the MCP endpoint on the public origin. The protected resource is this URL. */
export const MCP_RESOURCE_PATH = "/api/mcp/sse";

// ---------------------------------------------------------------------------
// Where we are
// ---------------------------------------------------------------------------

/**
 * The WEB origin users type into ChatGPT (https://fibuki.com): issuer, resource base and
 * the host of the authorize page. Not utils/publicOrigin.ts, which is the API host
 * (FIBUKI_PUBLIC_URL, https://new-api.fibuki.com in production). FIBUKI_WEB_ORIGIN is a
 * comma-separated CORS list; the first real origin is the one users reach.
 */
export function webOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const first = (env.FIBUKI_WEB_ORIGIN || "")
    .split(",")
    .map((o) => o.trim())
    .find((o) => o && o !== "*");
  return (first || "https://fibuki.com").replace(/\/+$/, "");
}

export function resourceUrl(origin: string = webOrigin()): string {
  return `${origin}${MCP_RESOURCE_PATH}`;
}

/** Where a client finds the protected resource metadata for the MCP endpoint (RFC 9728). */
export function resourceMetadataUrl(origin: string = webOrigin()): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

/** The value of the WWW-Authenticate header on a 401 from the MCP endpoint. */
export function bearerChallenge(error?: "invalid_token", origin: string = webOrigin()): string {
  return [
    'Bearer realm="fibuki"',
    `resource_metadata="${resourceMetadataUrl(origin)}"`,
    ...(error ? [`error="${error}"`] : []),
  ].join(", ");
}

export function authorizationServerMetadata(origin: string = webOrigin()) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SUPPORTED_SCOPES,
    // RFC 9207: every authorization response carries iss, which ChatGPT and Codex use to pick a stable redirect.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/integrations/chatgpt`,
  };
}

export function protectedResourceMetadata(origin: string = webOrigin()) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "FiBuKI",
    resource_documentation: `${origin}/integrations/chatgpt`,
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Authorization codes and refresh tokens: 256 random bits, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Access tokens are API keys, so the MCP endpoint, scopes, expiry and revocation stay one mechanism. */
export function generateAccessToken(): { token: string; hash: string; prefix: string } {
  const token = `fk_${randomBytes(16).toString("hex")}`;
  return { token, hash: sha256Hex(token), prefix: token.substring(0, 11) };
}

export function newClientId(): string {
  return `oc_${randomBytes(12).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CODE_CHALLENGE.test(value);
}

/** S256: BASE64URL(SHA256(verifier)) must equal the challenge sent at authorization. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !CODE_VERIFIER.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const url = parseUrl(uri);
  return !!url && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * A redirect URI a client may register: https, or http on a loopback address (native
 * apps and CLIs). No fragments, no credentials, no other schemes.
 */
export function isAcceptableRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  const url = parseUrl(uri);
  if (!url || url.hash || url.username || url.password) return false;
  return url.protocol === "https:" || isLoopbackRedirect(uri);
}

/**
 * Does `requested` match a registered URI? Exact, except that a loopback redirect may
 * use any port (the app picks a free one at run time, per RFC 8252).
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  if (!isLoopbackRedirect(requested)) return false;
  const want = parseUrl(requested)!;
  return registered.some((r) => {
    if (!isLoopbackRedirect(r)) return false;
    const have = parseUrl(r)!;
    return have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search;
  });
}

// ---------------------------------------------------------------------------
// Which app is this?
// ---------------------------------------------------------------------------

/** Hosts whose callbacks belong to the app they are named for. */
const KNOWN_APP_HOSTS: Record<string, "chatgpt" | "claude"> = {
  "chatgpt.com": "chatgpt",
  "claude.ai": "claude",
  "claude.com": "claude",
};

export interface AppIdentity {
  /** What FiBuKI records as the user's origin. Loopback apps are "api": Codex and Claude Code look alike. */
  origin: "chatgpt" | "claude" | "api";
  /** The callback host, shown to the user so a look-alike client name proves nothing. */
  host: string;
  /** True only for callbacks on a host that belongs to ChatGPT or Claude. */
  verified: boolean;
}

/** Client registration is open, so the name is the client's claim; the callback host is the evidence. */
export function appIdentityFor(redirectUri: string): AppIdentity {
  const url = parseUrl(redirectUri);
  const host = url?.hostname ?? "";
  const known = url?.protocol === "https:" ? KNOWN_APP_HOSTS[host] : undefined;
  return { origin: known ?? "api", host, verified: !!known };
}

// ---------------------------------------------------------------------------
// Registration (RFC 7591), the part that is pure
// ---------------------------------------------------------------------------

export interface ClientRegistration {
  clientName: string;
  redirectUris: string[];
}

export class OAuthRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** True when it is safe to send the error to the client's redirect URI. */
    public readonly redirectable = false
  ) {
    super(message);
  }
}

export function parseClientRegistration(body: unknown): ClientRegistration {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthRequestError("invalid_redirect_uri", `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs`);
  }
  if (!uris.every(isAcceptableRedirectUri)) {
    throw new OAuthRequestError(
      "invalid_redirect_uri",
      "Every redirect URI must be https, or http on localhost, 127.0.0.1 or [::1], without a fragment or credentials"
    );
  }
  // Public clients only: a registration asking for a secret-based method is told so, not given one.
  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new OAuthRequestError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method: none) are supported");
  }
  const grants = b.grant_types;
  if (Array.isArray(grants) && grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new OAuthRequestError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token");
  }

  const rawName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  // Control characters and markup have no business in a name shown on a consent screen.
  const clientName = rawName.replace(/[\u0000-\u001f<>]/g, "").slice(0, MAX_CLIENT_NAME_LENGTH) || "Connected app";

  return { clientName, redirectUris: [...new Set(uris as string[])] };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** The granted scope: what was asked for, defaulting to the one scope there is. Unknown scopes are an error. */
export function normalizeScope(requested: unknown): string {
  if (requested === undefined || requested === null || requested === "") return OAUTH_SCOPE;
  if (typeof requested !== "string") throw new OAuthRequestError("invalid_scope", "scope must be a string", true);
  const scopes = requested.split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return OAUTH_SCOPE;
  if (!scopes.every((s) => SUPPORTED_SCOPES.includes(s))) {
    throw new OAuthRequestError("invalid_scope", `Supported scopes: ${SUPPORTED_SCOPES.join(" ")}`, true);
  }
  return [...new Set(scopes)].join(" ");
}
