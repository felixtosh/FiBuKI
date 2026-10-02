/**
 * Server-side binding of an OAuth `state` to the user who started the flow.
 *
 * The callback must learn WHO connected the mailbox from something the browser
 * cannot write. A cookie is not that: the user edits their own cookies, so a
 * cookie holding a uid let anyone attach their mailbox to any account. The
 * state value travels through Google and back, so it cannot carry trust
 * either, but it can be the KEY to a record only the server wrote.
 *
 * authorize: createOAuthState(uid) stores { uid, expiresAt } under the hash of
 *            a fresh random state and hands the state to Google.
 * callback:  consumeOAuthState(state) reads that record and deletes it in one
 *            transaction. Unknown, expired or already used -> null.
 *
 * The record is keyed by a hash so the stored document never holds a live
 * state, and the collection is unlisted in the client data policy, so only
 * the server can read it.
 */

import crypto from "crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";

const COLLECTION = "oauthStates";
const TTL_MS = 10 * 60 * 1000;

function keyOf(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

export async function createOAuthState(userId: string, provider: string): Promise<string> {
  const state = crypto.randomBytes(32).toString("hex");
  await getAdminDb()
    .collection(COLLECTION)
    .doc(keyOf(state))
    .set({ userId, provider, expiresAt: Timestamp.fromMillis(Date.now() + TTL_MS) });
  return state;
}

/** The uid that started this flow, or null. A state works exactly once. */
export async function consumeOAuthState(state: string | null, provider: string): Promise<string | null> {
  if (!state || typeof state !== "string" || !/^[0-9a-f]{64}$/.test(state)) return null;
  const db = getAdminDb();
  const ref = db.collection(COLLECTION).doc(keyOf(state));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    const data = snap.data()!;
    const expiresAt = data.expiresAt as Timestamp | undefined;
    if (data.provider !== provider) return null;
    if (!expiresAt || expiresAt.toMillis() < Date.now()) return null;
    return typeof data.userId === "string" && data.userId ? data.userId : null;
  });
}
