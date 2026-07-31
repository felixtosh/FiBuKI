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
 * Mirrors the host's own verifier (functions/src/selfhost/better-auth.ts) so both
 * halves of the product agree on what a valid token is: same issuer, same audience,
 * same `sub`/`sid`/`admin` claims.
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

/**
 * Public base of fibuki-api, which is both the JWKS host and the token issuer.
 *
 * Read as a LITERAL process.env member expression: this module also runs in routes
 * Next may bundle for the edge, and only the literal form is inlined.
 */
function apiBase(): string {
  const url =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_API_URL) || "";
  return url.replace(/\/$/, "");
}

/**
 * Remote JWKS, cached by `jose` across requests. Created lazily so a build or a
 * route that never authenticates does not reach out, and rebuilt if the base URL
 * changes (which only happens in tests).
 */
let cachedBase: string | null = null;
let cachedKeySet: ReturnType<typeof createRemoteJWKSet> | null = null;

function keySet(base: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedKeySet || cachedBase !== base) {
    // jose handles caching, cooldown and refetch-on-unknown-kid, which is what
    // makes key rotation a non-event here.
    cachedKeySet = createRemoteJWKSet(new URL(`${base}/__auth/jwks`));
    cachedBase = base;
  }
  return cachedKeySet;
}

/** Test seam: drop the cached key set. */
export function __resetJwksCache(): void {
  cachedKeySet = null;
  cachedBase = null;
}

async function verifyBearerToken(request: Request): Promise<JWTPayload | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.substring(7).trim();
  if (!token) return null;

  const base = apiBase();
  if (!base) {
    // Misconfiguration, not an auth failure — say so once, loudly, because every
    // route will 401 until it is fixed and the cause is not otherwise visible.
    console.error(
      "[Auth:selfhost] NEXT_PUBLIC_FIBUKI_API_URL is not set; no JWKS to verify against",
    );
    return null;
  }

  try {
    // issuer === audience === the api base, matching how the host mints and
    // verifies (better-auth.ts `issuerUrl()`).
    const { payload } = await jwtVerify(token, keySet(base), {
      issuer: base,
      audience: base,
    });
    return payload;
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
