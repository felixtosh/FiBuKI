/**
 * Callable: the Transactions a Partner batch worker may pair its Files with
 * (#613).
 *
 * The agent's Partner batch used to pick its own pool: the Partner's
 * Transactions within 45 days of the batch's Files, over-quota ones dropped.
 * The pool is now the matcher's: each Transaction of the Partner that is
 * possible for at least one of the Files (the date window, Rejections,
 * over-quota), plus the ones the Files are already on, so the worker sees
 * what it may rebalance. Each carries the best Confidence any batch File
 * scored against it.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { transactionsForFiles } from "./matcher";

interface FindPartnerBatchTransactionsRequest {
  partnerId: string;
  fileIds: string[];
}

interface PartnerBatchTransaction {
  transactionId: string;
  /** Best Confidence a batch File scored against it; null for a Transaction a File is only on. */
  confidence: number | null;
}

interface FindPartnerBatchTransactionsResponse {
  transactions: PartnerBatchTransaction[];
}

/** Upper bound on the Files one call reads. */
const MAX_FILES = 100;

export const findPartnerBatchTransactionsCallable = createCallable<
  FindPartnerBatchTransactionsRequest,
  FindPartnerBatchTransactionsResponse
>({ name: "findPartnerBatchTransactions", timeoutSeconds: 60 }, async (ctx, request) => {
  const partnerId = request?.partnerId;
  const fileIds = request?.fileIds;
  if (typeof partnerId !== "string" || !partnerId) {
    throw new HttpsError("invalid-argument", "partnerId is required");
  }
  if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== "string" || !id)) {
    throw new HttpsError("invalid-argument", "fileIds must be a list of ids");
  }

  const partner = await ctx.db.collection("partners").doc(partnerId).get();
  // Someone else's Partner answers like one that exists nowhere.
  if (!partner.exists || partner.data()?.userId !== ctx.userId) {
    throw new HttpsError("not-found", "Partner not found");
  }

  const ids = [...new Set(fileIds)].slice(0, MAX_FILES);
  const snaps = ids.length ? await ctx.db.getAll(...ids.map((id) => ctx.db.collection("files").doc(id))) : [];
  const files = snaps
    .filter((snap) => snap.exists && snap.data()?.userId === ctx.userId)
    .map((snap) => ({ id: snap.id, data: snap.data()! }));

  const best = new Map<string, number | null>();
  const results = await transactionsForFiles(ctx.db, ctx.userId, files);
  for (const result of results) {
    for (const match of result.matches) {
      best.set(match.transactionId, Math.max(best.get(match.transactionId) ?? 0, match.confidence));
    }
  }
  // What the Files are already on, so the worker sees the occupancy it may rebalance.
  for (const file of files) {
    for (const txId of Array.isArray(file.data.transactionIds) ? file.data.transactionIds : []) {
      if (typeof txId === "string" && !best.has(txId)) best.set(txId, null);
    }
  }

  const txIds = [...best.keys()];
  const txSnaps = txIds.length
    ? await ctx.db.getAll(...txIds.map((id) => ctx.db.collection("transactions").doc(id)))
    : [];
  const transactions = txSnaps
    .filter((snap) => snap.exists && snap.data()?.userId === ctx.userId && snap.data()?.partnerId === partnerId)
    .map((snap) => ({ transactionId: snap.id, confidence: best.get(snap.id) ?? null }));

  return { transactions };
});
