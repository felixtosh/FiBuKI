/**
 * Self-host replacement for `lib/auth/get-server-user.ts`.
 *
 * Aliased at build time by next.config.ts when FIBUKI_BACKEND=selfhost, the same
 * way the client SDKs are swapped — so the ~45 routes under `app/api/*` keep
 * calling `getServerUserIdWithFallback()` and never learn which backend issued the
 * token.
 *
 * ## Why this has to exist
 *
 * The upstream helper verifies a FIREBASE ID token: RS256, signed by Google, checked
 * with firebase-admin. A self-host deployment has no Firebase — tokens come from
 * Better Auth and are signed **EdDSA** (Ed25519). firebase-admin therefore rejects a
 * perfectly valid token with
 *
 *   Firebase ID token has incorrect algorithm. Expected "RS256" but got "EdDSA"
 *
 * and every server-authenticated route answers 401. That is not a chat bug or a
 * share-page bug; it is every route under app/api that authenticates, which is why
 * they are all fixed by one alias rather than 45 edits.
 *
 * Mirrors the host's own verifier so both halves of the product agree on what a
 * valid token is — better-auth.ts in built-in mode (same issuer, same audience,
 * same `sub`/`sid`/`admin` claims), oidc-verifier.ts when OIDC_ISSUER selects an
 * external IdP (same issuer, optional audience, `admin` from group membership).
 * The mode is read from the same env the api reads; see `resolveVerifierConfig`.
 *
 * ## One deliberate difference from the host verifier
 *
 * The host also checks that the session row is still alive, so a revoked session is
 * rejected on the next request. This shim cannot: `fibuki-web` has no database
 * access, and giving it one purely for this would hand the web container the data
 * plane it currently does not need — a much larger change in blast radius than the
 * problem justifies.
 *
 * So here, a revoked session stays usable on the app/api surface until its JWT
 * expires. The window is the token lifetime, not indefinite, and the primary data
 * plane (fibuki-api) still enforces liveness on every call. Worth revisiting if
 * these routes ever carry something that must be revocable instantly.
 */

import { NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Thrown for a missing/invalid token so route catch blocks answer 401 rather than a
 * generic 500. Same shape and name as the Firebase implementation — routes do
 * `error instanceof UnauthorizedError`, so this must stay identical.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized: Missing or invalid Authorization header");
    this.name = "UnauthorizedError";
  }
}

/** The one 401 shape every route answers with. Mirrors the upstream helper. */
export function unauthorizedResponse(error: unknown): NextResponse | null {
  return error instanceof UnauthorizedError
    ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    : null;
}

// Strip CR/LF so request-derived values cannot forge log lines.
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

function stripSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Env reads stay LITERAL process.env member expressions: this module also runs in
 * routes Next may bundle for the edge, and only the literal form is inlined.
 */
function env(read: () => string | undefined): string {
  return (typeof process !== "undefined" && read()) || "";
}

/**
 * Which verifier the host runs, resolved from the SAME env the api container reads
 * (server.ts): OIDC_ISSUER set → external IdP; unset → built-in Better Auth. The
 * two halves must agree, or the browser holds a token the api accepts and every
 * app/api route refuses.
 *
 * Two URLs per mode on purpose. `issuer` is what tokens are minted with — public,
 * browser-facing. `jwksUrl` is where THIS container fetches keys, which may need
 * to be a directly-reachable address: a compose network has no route to its own
 * public hostname when the reverse proxy sits on another host, so the public URL
 * times out and every route 401s with "request timed out" as the only trace.
 *   - OIDC: OIDC_JWKS_URI (the api's own escape hatch), else discovery.
 *   - built-in: NEXT_PUBLIC_FUNCTIONS_URL (the api's compose service URL, already
 *     used by the /api/mcp proxies for the same reason), else the public base.
 */
interface VerifierConfig {
  mode: "oidc" | "builtin";
  issuer: string;
  /** Undefined → skip the aud check (mirrors oidc-verifier.ts). */
  audience?: string;
  /** Resolved lazily: OIDC discovery is a network call. */
  jwksUrl: () => Promise<string>;
  /** OIDC only: `admin` derives from group membership, as in oidc-verifier.ts. */
  groupsClaim: string;
  adminGroup?: string;
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const url = new URL(".well-known/openid-configuration", base).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`OIDC discovery at ${url} exposed no jwks_uri`);
  return doc.jwks_uri;
}

function resolveVerifierConfig(): VerifierConfig | null {
  const oidcIssuer = env(() => process.env?.OIDC_ISSUER);
  if (oidcIssuer) {
    const jwksUri = env(() => process.env?.OIDC_JWKS_URI);
    return {
      mode: "oidc",
      issuer: oidcIssuer,
      audience: env(() => process.env?.OIDC_AUDIENCE) || undefined,
      jwksUrl: async () => jwksUri || discoverJwksUri(oidcIssuer),
      groupsClaim: env(() => process.env?.OIDC_GROUPS_CLAIM) || "groups",
      adminGroup: env(() => process.env?.OIDC_ADMIN_GROUP) || undefined,
    };
  }

  const publicBase = stripSlash(env(() => process.env?.NEXT_PUBLIC_FIBUKI_API_URL));
  if (!publicBase) return null;
  const internalBase = stripSlash(env(() => process.env?.NEXT_PUBLIC_FUNCTIONS_URL));
  return {
    mode: "builtin",
    // issuer === audience === the api base, matching how the host mints and
    // verifies (better-auth.ts `issuerUrl()`).
    issuer: publicBase,
    audience: publicBase,
    // Same path the host serves: Better Auth's jwt plugin under /__auth.
    jwksUrl: async () => `${internalBase || publicBase}/__auth/jwks`,
    groupsClaim: "groups",
  };
}

/**
 * Remote JWKS, cached by `jose` across requests. Created lazily so a build or a
 * route that never authenticates does not reach out, and rebuilt if the config
 * changes (which only happens in tests).
 */
let cachedKey: string | null = null;
let cachedKeySet: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

function keySet(cfg: VerifierConfig): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const key = `${cfg.mode}|${cfg.issuer}|${cfg.audience ?? ""}`;
  if (!cachedKeySet || cachedKey !== key) {
    // jose handles caching, cooldown and refetch-on-unknown-kid, which is what
    // makes key rotation a non-event here.
    cachedKeySet = cfg.jwksUrl().then((url) => createRemoteJWKSet(new URL(url)));
    cachedKey = key;
    // A failed discovery must not be cached as a permanent 401.
    cachedKeySet.catch(() => {
      if (cachedKey === key) {
        cachedKeySet = null;
        cachedKey = null;
      }
    });
  }
  return cachedKeySet;
}

/** Test seam: drop the cached key set. */
export function __resetJwksCache(): void {
  cachedKeySet = null;
  cachedKey = null;
}

function deriveAdmin(payload: JWTPayload, cfg: VerifierConfig): boolean {
  if (cfg.mode === "builtin") return payload.admin === true;
  if (!cfg.adminGroup) return false;
  const groups = payload[cfg.groupsClaim];
  if (Array.isArray(groups)) return groups.includes(cfg.adminGroup);
  if (typeof groups === "string") return groups === cfg.adminGroup;
  return false;
}

async function verifyBearerToken(request: Request): Promise<JWTPayload | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.substring(7).trim();
  if (!token) return null;

  const cfg = resolveVerifierConfig();
  if (!cfg) {
    // Misconfiguration, not an auth failure — say so once, loudly, because every
    // route will 401 until it is fixed and the cause is not otherwise visible.
    console.error(
      "[Auth:selfhost] neither OIDC_ISSUER nor NEXT_PUBLIC_FIBUKI_API_URL is set; no JWKS to verify against",
    );
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, await keySet(cfg), {
      issuer: cfg.issuer,
      ...(cfg.audience ? { audience: cfg.audience } : {}),
    });
    // Normalise so callers see one `admin` shape regardless of mode; a user-set
    // `admin` claim on an OIDC token is ignored, group membership decides.
    return { ...payload, admin: deriveAdmin(payload, cfg) };
  } catch (e) {
    console.warn("[Auth:selfhost] Token verification failed:", sanitizeForLog(e));
    return null;
  }
}

/**
 * Get the authenticated user's ID from a request.
 *
 * Name kept for source compatibility with the Firebase helper; there is no
 * unverified fallback in either implementation.
 */
export async function getServerUserIdWithFallback(request: Request): Promise<string> {
  const payload = await verifyBearerToken(request);
  const uid = typeof payload?.sub === "string" ? payload.sub : "";
  if (uid) return uid;
  throw new UnauthorizedError();
}

/**
 * Check the `admin` claim on the VERIFIED token.
 *
 * The host puts it there from the user's customClaims, stripping any registered JWT
 * claim name first, so it cannot be spoofed by a user-set claim.
 */
export async function isServerUserAdmin(request: Request): Promise<boolean> {
  const payload = await verifyBearerToken(request);
  return payload?.admin === true;
}
