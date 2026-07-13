/**
 * Server-side authentication helpers
 *
 * Verifies Firebase ID tokens (RS256 signature, expiry, issuer, audience)
 * via the Admin SDK before trusting any identity claim.
 *
 * SECURITY: never decode-without-verify a JWT for authorization. A decoded-only
 * token lets any caller forge `{ user_id: <any> }` / `{ admin: true }` and act
 * as any user. All identity here must come from `verifyIdToken`.
 */

import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { getAdminApp } from "@/lib/firebase/admin";

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
    console.warn("[Auth] Token verification failed:", (e as Error)?.message);
    return null;
  }
}

/**
 * Get the authenticated user's ID from a request.
 * Requires a valid, signature-verified Firebase ID token.
 * Throws if the token is missing or invalid.
 *
 * (Name kept for backwards compatibility with existing call sites; there is
 * no longer any unverified fallback.)
 */
export async function getServerUserIdWithFallback(
  request: Request
): Promise<string> {
  const decoded = await verifyBearerToken(request);
  if (decoded?.uid) {
    return decoded.uid;
  }
  throw new Error("Unauthorized: Missing or invalid Authorization header");
}

/**
 * Check whether the authenticated user is an admin.
 * Reads the `admin` custom claim from the VERIFIED token only.
 */
export async function isServerUserAdmin(request: Request): Promise<boolean> {
  const decoded = await verifyBearerToken(request);
  return decoded?.admin === true;
}
