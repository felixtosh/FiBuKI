/**
 * Re-score a partner's already-connected files after its billing cycle is
 * learned or changes.
 *
 * A file connection's `matchConfidence`/`scoreBreakdown`/`matchSources` are
 * fixed at connect time (`matchFileTransactions.ts`, `connectFileToTransaction.ts`).
 * They never update on their own once a partner's billing cycle later reveals
 * that a candidate belongs to a different charge (yazzbert/FiBuKI-selfhost#168)
 * — this re-derives them for every connection of the partner's transactions,
 * using the same `scoreTransaction` the initial match used, so the correct
 * charge for a same-amount recurring document ends up with the highest score
 * without disturbing which files are actually connected (connectionType and
 * the connection's existence are never touched).
 */

import {
  scoreTransaction,
  FileMatchingData,
  TransactionData,
  ScoringOptions,
} from "./transactionScoring";
import { selectEffectiveCycleForAmount, ResolvedEffectiveCycle } from "./billingCycle";

/** Firestore batch write cap is 500; chunk with headroom. */
const BATCH_CHUNK_SIZE = 400;
/** Firestore 'in' query cap. */
const QUERY_CHUNK_SIZE = 30;

export async function rescoreFileConnectionsForPartner(
  db: FirebaseFirestore.Firestore,
  userId: string,
  partnerId: string,
  txDocs: FirebaseFirestore.QueryDocumentSnapshot[],
  effective: ResolvedEffectiveCycle[],
  weights: ScoringOptions["weights"] | undefined,
  partnerAliases: string[]
): Promise<{ rescored: number }> {
  if (txDocs.length === 0) return { rescored: 0 };

  const txById = new Map(txDocs.map((doc) => [doc.id, doc]));
  const txIds = [...txById.keys()];

  const connections: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (let i = 0; i < txIds.length; i += QUERY_CHUNK_SIZE) {
    const batch = txIds.slice(i, i + QUERY_CHUNK_SIZE);
    const snapshot = await db
      .collection("fileConnections")
      .where("transactionId", "in", batch)
      .where("userId", "==", userId)
      .get();
    connections.push(...snapshot.docs);
  }

  if (connections.length === 0) return { rescored: 0 };

  const fileIds = [...new Set(connections.map((c) => c.data().fileId as string))];
  const filesById = new Map<string, FirebaseFirestore.DocumentData>();
  for (let i = 0; i < fileIds.length; i += QUERY_CHUNK_SIZE) {
    const batch = fileIds.slice(i, i + QUERY_CHUNK_SIZE);
    const snapshot = await db
      .collection("files")
      .where("__name__", "in", batch)
      .get();
    for (const doc of snapshot.docs) filesById.set(doc.id, doc.data());
  }

  let batch = db.batch();
  let pending = 0;
  let rescored = 0;

  for (const connectionDoc of connections) {
    const connData = connectionDoc.data();
    const txDoc = txById.get(connData.transactionId);
    const fileData = filesById.get(connData.fileId);
    if (!txDoc || !fileData) continue;

    const txData = txDoc.data();
    const transactionData: TransactionData = {
      id: txDoc.id,
      amount: txData.amount,
      date: txData.date,
      currency: txData.currency,
      name: txData.name,
      partner: txData.partner,
      partnerName: txData.partnerName,
      partnerId: txData.partnerId,
      partnerIban: txData.partnerIban,
      reference: txData.reference,
    };

    const fileMatchingData: FileMatchingData = {
      extractedAmount: fileData.extractedAmount,
      extractedCurrency: fileData.extractedCurrency,
      extractedDate: fileData.extractedDate,
      extractedPartner: fileData.extractedPartner,
      extractedIban: fileData.extractedIban,
      extractedText: fileData.extractedText,
      partnerId: fileData.partnerId,
      precisionSearchHint: fileData.precisionSearchHint,
    };

    const band = selectEffectiveCycleForAmount(effective, transactionData.amount);
    let scoringOptions: ScoringOptions | undefined;
    if (band || weights) {
      scoringOptions = {};
      if (band) {
        scoringOptions.billingCycle = {
          invoiceToTransactionDelay: band.invoiceToTransactionDelay,
          delayVariance: band.delayVariance,
          frequencyDays: band.frequencyDays,
          dayVariance: band.dayVariance,
        };
      }
      if (weights) scoringOptions.weights = weights;
    }

    const result = scoreTransaction(
      fileMatchingData,
      transactionData,
      partnerAliases,
      scoringOptions
    );

    batch.update(connectionDoc.ref, {
      matchConfidence: result.confidence,
      scoreBreakdown: result.breakdown,
      matchSources: result.matchSources,
    });
    pending++;
    rescored++;

    if (pending >= BATCH_CHUNK_SIZE) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();

  console.log(`[BillingCycle] Re-scored ${rescored} connection(s) for partner ${partnerId}`);
  return { rescored };
}
