/**
 * Shared HMAC token helpers for email unsubscribe links.
 * Used by digest and budget warning unsubscribe endpoints.
 */

import { createHmac, timingSafeEqual } from "crypto";

const UNSUBSCRIBE_SECRET =
  process.env.DIGEST_HMAC_SECRET || "fibuki-digest-2026";

/**
 * Generate an HMAC token for a given userId + category.
 * The category is mixed into the HMAC so tokens are scoped per email type.
 */
export function generateUnsubscribeToken(
  userId: string,
  category: "digest" | "budgetWarnings" = "digest"
): string {
  return createHmac("sha256", UNSUBSCRIBE_SECRET)
    .update(`${category}:${userId}`)
    .digest("hex");
}

/**
 * Verify an HMAC unsubscribe token (constant-time comparison).
 */
export function verifyUnsubscribeToken(
  userId: string,
  token: string,
  category: "digest" | "budgetWarnings" = "digest"
): boolean {
  const expected = generateUnsubscribeToken(userId, category);
  if (expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

/**
 * Build a full unsubscribe URL for a given category.
 */
export function buildUnsubscribeUrl(
  userId: string,
  category: "digest" | "budgetWarnings"
): string {
  const token = generateUnsubscribeToken(userId, category);
  const endpoint =
    category === "digest" ? "unsubscribeDigest" : "unsubscribeBudgetWarnings";
  return `https://europe-west1-taxstudio-f12fb.cloudfunctions.net/${endpoint}?uid=${userId}&token=${token}`;
}
