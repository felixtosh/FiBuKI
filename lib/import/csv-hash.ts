/**
 * Utility to compute SHA-256 hash of CSV content.
 * Used for detecting duplicate CSV uploads.
 */

/**
 * Compute SHA-256 hash of CSV content.
 * Uses Web Crypto API for hashing.
 */
export async function computeCsvHash(content: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
