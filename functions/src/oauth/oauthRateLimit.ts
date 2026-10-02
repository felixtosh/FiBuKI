/**
 * Limit on dynamic client registration, the one OAuth endpoint anyone on the internet can write through.
 *
 * Counters live in the database (fixed one-hour window) so every replica sees the same numbers. The caller's
 * address comes from the first X-Forwarded-For entry, which the web proxy passes on and Caddy sets; it is stored
 * only as a short hash and the cleanup job removes it after the window. There is also a global ceiling, because an
 * attacker with many addresses is not stopped by a per-address cap.
 *
 * Token exchange is not limited here: its inputs are 256-bit secrets, so there is nothing to guess, and the host's
 * general per-address limiter already bounds its cost.
 */

import { createHash } from "crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

export const RATE_LIMITS = "oauthRateLimits";
export const WINDOW_MS = 60 * 60 * 1000;
export const REGISTER_PER_ADDRESS = 20;
export const REGISTER_GLOBAL = 300;

export interface SlotResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function clientAddress(headers: Record<string, unknown> | undefined): string | null {
  const raw = headers?.["x-forwarded-for"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const first = value.split(",")[0].trim();
  return first && first.length <= 64 ? first : null;
}

export async function takeRegistrationSlot(
  db: Firestore,
  address: string | null,
  nowMs: number = Date.now()
): Promise<SlotResult> {
  const window = Math.floor(nowMs / WINDOW_MS);
  const windowEnd = (window + 1) * WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd - nowMs) / 1000));

  const addressKey = address ? createHash("sha256").update(address).digest("hex").slice(0, 24) : "unknown";
  const globalRef = db.collection(RATE_LIMITS).doc(`register-${window}-all`);
  const addressRef = db.collection(RATE_LIMITS).doc(`register-${window}-a-${addressKey}`);

  const allowed = await db.runTransaction(async (tx) => {
    const [globalSnap, addressSnap] = await Promise.all([tx.get(globalRef), tx.get(addressRef)]);
    const globalCount = (globalSnap.data()?.count as number | undefined) ?? 0;
    const addressCount = (addressSnap.data()?.count as number | undefined) ?? 0;
    if (globalCount >= REGISTER_GLOBAL || addressCount >= REGISTER_PER_ADDRESS) return false;

    const expiresAt = Timestamp.fromMillis(windowEnd);
    tx.set(globalRef, { count: globalCount + 1, windowEnd: expiresAt });
    tx.set(addressRef, { count: addressCount + 1, windowEnd: expiresAt });
    return true;
  });

  return { allowed, retryAfterSeconds };
}
