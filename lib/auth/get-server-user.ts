/**
 * Server-side authentication helpers
 *
 * Extracts user ID from Firebase Auth tokens.
 * In production, would verify Firebase ID tokens (requires firebase-admin setup).
 */

/**
 * Get user ID from request Authorization header
 * Requires a valid Firebase Auth token
 */
export async function getServerUserIdWithFallback(
  request: Request
): Promise<string> {
  const authHeader = request.headers.get("Authorization");

  // If we have an auth header with a token, extract user ID from it
  if (authHeader?.startsWith("Bearer ")) {
    // In a full production setup, you would verify the token with firebase-admin
    // For now, we trust the token and extract the user ID from it
    // The token is a JWT - we can decode (not verify) to get the uid
    const token = authHeader.substring(7);
    try {
      const payload = decodeJwtPayload(token) as { user_id?: string; sub?: string } | null;
      if (payload?.user_id || payload?.sub) {
        return payload.user_id || payload.sub || "";
      }
      console.warn("[Auth] Token decoded but no user_id or sub found:", Object.keys(payload || {}));
    } catch (e) {
      console.warn("[Auth] Failed to decode token:", e);
    }
  } else {
    console.warn("[Auth] No Bearer token in Authorization header:", authHeader?.substring(0, 20));
  }

  throw new Error("Unauthorized: Missing or invalid Authorization header");
}

/**
 * Decode JWT payload without verification
 * Only use this for development/emulator mode
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Firebase uses base64url encoding (not standard base64)
    // Convert base64url to base64: replace - with +, _ with /, add padding
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed
    while (payload.length % 4) {
      payload += "=";
    }

    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (e) {
    console.warn("[Auth] JWT decode error:", e);
    return null;
  }
}

/**
 * Check if the user is an admin (development stub)
 */
export async function isServerUserAdmin(request: Request): Promise<boolean> {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.substring(7);

  try {
    const payload = decodeJwtPayload(token);
    return payload?.admin === true;
  } catch {
    return false;
  }
}
