/**
 * Housekeeping for the OAuth tables, so open registration cannot grow them for ever.
 *
 *  - oauthCodes: a code lives 10 minutes. A used code is kept a day past that, because exchanging it again is how
 *    we detect a stolen code and revoke its grant; after that it can do nothing and goes.
 *  - oauthClients: dynamic registration is open to anyone, so clients that never got a grant (nobody approved
 *    them) are deleted after 90 days. A client that has ever been given a grant is kept: apps cache their
 *    client_id, and dropping it would break a connection or its refresh.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

const CODES = "oauthCodes";
const CLIENTS = "oauthClients";
const API_KEYS = "apiKeys";

export const CODE_RETENTION_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const UNUSED_CLIENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BATCH = 200;
/** Per run, so one run is bounded; the next day continues. */
const MAX_PER_RUN = 2000;

export interface CleanupResult {
  codesDeleted: number;
  clientsDeleted: number;
  rateWindowsDeleted: number;
}

/** Counters of finished windows (they hold a hash of the caller's address). */
async function deleteFinishedRateWindows(db: Firestore, nowMs: number): Promise<number> {
  const snapshot = await db
    .collection("oauthRateLimits")
    .where("windowEnd", "<", Timestamp.fromMillis(nowMs))
    .limit(MAX_PER_RUN)
    .get();
  for (const doc of snapshot.docs) await doc.ref.delete();
  return snapshot.docs.length;
}

async function deleteExpiredCodes(db: Firestore, nowMs: number): Promise<number> {
  const cutoff = Timestamp.fromMillis(nowMs - CODE_RETENTION_AFTER_EXPIRY_MS);
  let deleted = 0;
  while (deleted < MAX_PER_RUN) {
    const snapshot = await db.collection(CODES).where("expiresAt", "<", cutoff).limit(BATCH).get();
    if (snapshot.empty) break;
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snapshot.docs.length;
    if (snapshot.docs.length < BATCH) break;
  }
  return deleted;
}

async function deleteUnusedClients(db: Firestore, nowMs: number): Promise<number> {
  const cutoff = Timestamp.fromMillis(nowMs - UNUSED_CLIENT_MAX_AGE_MS);
  const old = await db.collection(CLIENTS).where("createdAt", "<", cutoff).limit(MAX_PER_RUN).get();

  let deleted = 0;
  for (const client of old.docs) {
    const grant = await db.collection(API_KEYS).where("oauthClientId", "==", client.id).limit(1).get();
    if (!grant.empty) continue;
    await client.ref.delete();
    deleted += 1;
  }
  return deleted;
}

export async function cleanupOAuthRecords(db: Firestore, nowMs: number = Date.now()): Promise<CleanupResult> {
  return {
    codesDeleted: await deleteExpiredCodes(db, nowMs),
    clientsDeleted: await deleteUnusedClients(db, nowMs),
    rateWindowsDeleted: await deleteFinishedRateWindows(db, nowMs),
  };
}

export const cleanupOAuth = onSchedule(
  { schedule: "20 4 * * *", region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 },
  async () => {
    const result = await cleanupOAuthRecords(getFirestore());
    console.log("[cleanupOAuth]", result);
  }
);
