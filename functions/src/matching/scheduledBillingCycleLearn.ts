/**
 * Nightly billing-cycle auto-learn (yazzbert/FiBuKI-selfhost#166).
 *
 * Walks every partner that has enough charge history and re-runs the pure
 * learner in ./billingCycle.ts through the shared writer in
 * ./learnBillingCycle.ts, so a cycle stays current as new bank transactions
 * arrive without anyone calling learnBillingCycle by hand.
 *
 * History only — no AI call. The derivation is arithmetic over transaction
 * dates and amounts, and a nightly full-book pass is precisely where a
 * per-partner model call would be unaffordable.
 *
 * Self-host picks this up automatically: cron-host walks the index.ts barrel
 * for onSchedule exports, so the export at the bottom is all the wiring
 * there is.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import {
  learnBillingCycleForPartner,
  MIN_BILLING_CYCLE_TRANSACTIONS,
} from "./learnBillingCycle";

const db = getFirestore();

/** Partners read per run. A nightly refresh, not a backfill of an archive. */
const PARTNER_SCAN_LIMIT = 2000;

/**
 * Charges scanned per user to count history per partner. Newest first, so a
 * user over the cap keeps the recent history a cycle is actually derived
 * from.
 */
const TRANSACTION_SCAN_LIMIT = 5000;

export interface NightlyBillingCycleResult {
  users: number;
  /** Partners that cleared the history threshold and were re-learned. */
  eligible: number;
  /** Of those, the ones whose history yielded a cycle. */
  learned: number;
}

/**
 * Re-learn the billing cycle of every partner with enough history.
 *
 * Extracted from the scheduled handler so the self-host scheduler shim (and
 * a test) can exercise it directly; the `onSchedule` export below only wraps
 * it.
 */
export async function learnBillingCyclesForAllUsers(): Promise<NightlyBillingCycleResult> {
  const partnersSnapshot = await db.collection("partners").limit(PARTNER_SCAN_LIMIT).get();

  if (partnersSnapshot.size === PARTNER_SCAN_LIMIT) {
    console.warn(
      `[BillingCycle] Nightly learn hit the ${PARTNER_SCAN_LIMIT}-partner scan cap; ` +
      `partners beyond it were not re-learned this run`
    );
  }

  // Group by owner: the run is per user, because the history count that
  // gates a partner comes from one scan of that user's transactions.
  const partnersByUser = new Map<string, string[]>();
  for (const doc of partnersSnapshot.docs) {
    const userId = doc.data().userId;
    if (typeof userId !== "string" || !userId) continue;
    const owned = partnersByUser.get(userId) ?? [];
    owned.push(doc.id);
    partnersByUser.set(userId, owned);
  }

  console.log(
    `[BillingCycle] Nightly learn: ${partnersSnapshot.size} partner(s) across ` +
    `${partnersByUser.size} user(s)`
  );

  let eligible = 0;
  let learned = 0;

  for (const [userId, partnerIds] of partnersByUser) {
    const counts = await countTransactionsByPartner(userId);

    for (const partnerId of partnerIds) {
      if ((counts.get(partnerId) ?? 0) < MIN_BILLING_CYCLE_TRANSACTIONS) continue;
      eligible++;

      try {
        // Re-queries the partner's own history rather than reusing the count
        // scan: that is the canonical window (newest 100, oldest first) every
        // other learn path uses, and one shared query shape is the point.
        const cycle = await learnBillingCycleForPartner(db, userId, partnerId);
        if (cycle) learned++;
      } catch (error) {
        // One unhappy partner must not end the walk for the rest.
        console.error(`[BillingCycle] Nightly learn failed for partner ${partnerId}:`, error);
      }
    }
  }

  console.log(
    `[BillingCycle] Nightly learn complete: ${eligible} partner(s) with ` +
    `${MIN_BILLING_CYCLE_TRANSACTIONS}+ transactions, ${learned} cycle(s) written`
  );

  return { users: partnersByUser.size, eligible, learned };
}

/** Transactions per partnerId for one user. bankPartnerId is not counted. */
async function countTransactionsByPartner(userId: string): Promise<Map<string, number>> {
  const snapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "desc")
    .limit(TRANSACTION_SCAN_LIMIT)
    .get();

  if (snapshot.size === TRANSACTION_SCAN_LIMIT) {
    console.warn(
      `[BillingCycle] Transaction scan for user ${userId} hit the ` +
      `${TRANSACTION_SCAN_LIMIT} cap; older charges were not counted`
    );
  }

  const counts = new Map<string, number>();
  for (const doc of snapshot.docs) {
    const partnerId = doc.data().partnerId;
    if (typeof partnerId !== "string" || !partnerId) continue;
    counts.set(partnerId, (counts.get(partnerId) ?? 0) + 1);
  }
  return counts;
}

export const scheduledLearnBillingCycles = onSchedule(
  {
    schedule: "0 3 * * *", // 03:00 Vienna — after the nightly mail sync, before the working day
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async () => {
    await learnBillingCyclesForAllUsers();
  }
);
