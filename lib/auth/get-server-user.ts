/**
 * Server-side authentication helpers
 *
 * Verifies Firebase ID tokens (RS256 signature, expiry, issuer, audience) via
 * the Admin SDK before trusting any identity claim. In dev the Admin app is
 * pointed at the Auth emulator (lib/firebase/admin.ts sets
 * FIREBASE_AUTH_EMULATOR_HOST at module load), so emulator tokens verify too.
 *
 * SECURITY: never decode-without-verify a JWT for authorization. A decoded-only
 * token lets any caller forge `{ user_id: <any> }` / `{ admin: true }` and act
 * as any user. All user identity here must come from `verifyIdToken`, or from a
 * trusted server-to-server call authenticated with the shared internal secret.
 *
 * Self-host builds never route auth through these helpers: the browser talks to
 * fibuki-api directly, and the Next API routes are not part of the self-host
 * data plane.
 */

import { NextResponse } from "next/server";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getAdminApp } from "@/lib/firebase/admin";
import { timingSafeEqual } from "crypto";

/**
 * Thrown by getServerUserIdWithFallback for a missing/invalid token so route
 * catch blocks can answer 401 instead of a generic 500 (W1 decision 2026-07-21,
 * docs/decisions.md: 401 shaping approved).
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized: Missing or invalid Authorization header");
    this.name = "UnauthorizedError";
  }
}

/**
 * The one 401 shape every route answers with — returns the response for an
 * UnauthorizedError and null for anything else, so a route catch can open with:
 *
 *   const unauthorized = unauthorizedResponse(error);
 *   if (unauthorized) return unauthorized;
 *
 * Never includes internal error text (two routes used to echo it).
 */
export function unauthorizedResponse(error: unknown): NextResponse | null {
  return error instanceof UnauthorizedError
    ? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    : null;
}

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

/**
 * Trusted server-to-server path.
 *
 * A caller that holds the shared internal secret (e.g. a Cloud Function that
 * needs to run a worker on behalf of a user) may assert the user id via headers
 * instead of presenting a Firebase ID token. Disabled unless a sufficiently
 * strong INTERNAL_API_SECRET is configured, so the default posture stays
 * "verified token only".
 *
 * Returns the asserted user id, or null when the internal path does not apply.
 */
function getInternalUserId(request: Request): string | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || secret.length < 16) return null;

  const provided = request.headers.get("X-Internal-Secret");
  if (!provided) return null;

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const uid = request.headers.get("X-Internal-User-Id")?.trim();
  return uid ? uid : null;
}

/**
 * Verify the Bearer token on a request and return its decoded, verified claims.
 * Returns null when there is no Bearer token or verification fails.
 *
 * `verifyIdToken` checks the signature against Google's public keys plus
 * expiry / issuer / audience. It transparently uses the Auth emulator when
 * FIREBASE_AUTH_EMULATOR_HOST is set (see lib/firebase/admin.ts).
 */
async function verifyBearerToken(
  request: Request
): Promise<DecodedIdToken | null> {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    console.warn("[Auth] No Bearer token in Authorization header");
    return null;
  }

  const token = authHeader.substring(7).trim();
  if (!token) return null;

  try {
    return await getAuth(getAdminApp()).verifyIdToken(token);
  } catch (e) {
    console.warn("[Auth] Token verification failed:", sanitizeForLog(e));
    return null;
  }
}

/**
 * Get the authenticated user's ID from a request.
 * Accepts either a valid, signature-verified Firebase ID token, or a trusted
 * server-to-server call carrying the shared internal secret.
 * Throws UnauthorizedError if neither is present/valid.
 *
 * (Name kept for backwards compatibility with existing call sites; there is
 * no longer any unverified fallback.)
 */
export async function getServerUserIdWithFallback(
  request: Request
): Promise<string> {
  const internalUserId = getInternalUserId(request);
  if (internalUserId) {
    return internalUserId;
  }

  const decoded = await verifyBearerToken(request);
  if (decoded?.uid) {
    return decoded.uid;
  }

  throw new UnauthorizedError();
}

/**
 * Check whether the authenticated user is an admin.
 * Reads the `admin` custom claim from the VERIFIED token only. Internal
 * service-secret callers are never treated as admins.
 */
export async function isServerUserAdmin(request: Request): Promise<boolean> {
  const decoded = await verifyBearerToken(request);
  return decoded?.admin === true;
}
