/**
 * Queue per-Transaction mail search for every incomplete Transaction of a user.
 *
 * Since #103 this is how receipts for historical Transactions are found: a
 * mailbox is no longer bulk-pulled over the user's transaction span, it is
 * searched per undocumented Transaction by the precision search worker.
 * Triggered when a first Sync completes, after an Import, and on reconnect.
 *
 * No `firebase-functions` import, so it can run in either self-host container.
 */

import { Timestamp } from "firebase-admin/firestore";

/** Strategies a system-triggered search runs, cheapest first. */
export const SYSTEM_SEARCH_STRATEGIES = [
  "partner_files",
  "amount_files",
  "email_attachment",
  "email_invoice",
];

export interface QueueIncompleteSearchResult {
  queued: boolean;
  queueId?: string;
  transactionsToProcess: number;
}

/**
 * Queue one `all_incomplete` precision search, unless one is already pending
 * or processing for the user, or nothing is incomplete. `extra` is merged into
 * the queue item for provenance (e.g. the import or sync that triggered it).
 */
export async function queueIncompleteTransactionSearch(
  db: FirebaseFirestore.Firestore,
  userId: string,
  triggeredBy: string,
  extra: Record<string, unknown> = {}
): Promise<QueueIncompleteSearchResult> {
  const existing = await db
    .collection("precisionSearchQueue")
    .where("userId", "==", userId)
    .where("status", "in", ["pending", "processing"])
    .limit(1)
    .get();
  if (!existing.empty) {
    console.log(`[PrecisionSearch] ${userId} already has a pending precision search, skipping`);
    return { queued: false, transactionsToProcess: 0 };
  }

  const incomplete = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("isComplete", "==", false)
    .count()
    .get();
  const transactionsToProcess = incomplete.data().count;
  if (transactionsToProcess === 0) {
    return { queued: false, transactionsToProcess: 0 };
  }

  const docRef = await db.collection("precisionSearchQueue").add({
    userId,
    scope: "all_incomplete",
    triggeredBy,
    triggeredByAuthor: { type: "system", userId },
    ...extra,
    status: "pending",
    transactionsToProcess,
    transactionsProcessed: 0,
    transactionsWithMatches: 0,
    totalFilesConnected: 0,
    strategies: SYSTEM_SEARCH_STRATEGIES,
    currentStrategyIndex: 0,
    errors: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: Timestamp.now(),
  });

  console.log(
    `[PrecisionSearch] Queued precision search ${docRef.id} for ${transactionsToProcess} ` +
      `incomplete transactions (${triggeredBy})`
  );
  return { queued: true, queueId: docRef.id, transactionsToProcess };
}
