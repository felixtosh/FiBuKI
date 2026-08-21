/**
 * Learn a partner's billing cycle from transaction date intervals.
 *
 * Fetches the partner's transaction (and connected-file) history and hands
 * it to the pure derivation in ./billingCycle.ts. The algorithm itself lives
 * there; this file is Firestore I/O only.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  deriveLearnedCycles,
  resolveEffectiveCycles,
  type BillingCycleTransaction,
  type DerivedBillingCycle,
} from "./billingCycle";
import { rescoreFileConnectionsForPartner } from "./rescoreFileConnections";

const db = getFirestore();

interface LearnBillingCycleRequest {
  partnerId: string;
}

interface LearnBillingCycleResponse {
  success: boolean;
  billingCycle: DerivedBillingCycle | null;
}

export const learnBillingCycleCallable = createCallable<
  LearnBillingCycleRequest,
  LearnBillingCycleResponse
>(
  { name: "learnBillingCycle" },
  async (ctx, request) => {
    const { partnerId } = request;

    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }

    // Verify partner ownership
    const partnerRef = ctx.db.collection("partners").doc(partnerId);
    const partnerSnap = await partnerRef.get();
    if (!partnerSnap.exists || partnerSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("not-found", "Partner not found");
    }

    // Query transactions for this partner, ordered by date. partnerId only —
    // never bankPartnerId, which reflects the bank's descriptor rather than
    // the resolved supplier and would pollute the learned cycle.
    const txSnapshot = await ctx.db
      .collection("transactions")
      .where("userId", "==", ctx.userId)
      .where("partnerId", "==", partnerId)
      .orderBy("date", "asc")
      .limit(100)
      .get();

    if (txSnapshot.size < 3) {
      console.log(`[BillingCycle] Not enough transactions for partner ${partnerId}: ${txSnapshot.size}`);
      return { success: true, billingCycle: null };
    }

    const invoiceDates = await getInvoiceDates(ctx.userId, partnerId, txSnapshot.docs);
    const transactions: BillingCycleTransaction[] = txSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        date: data.date.toDate(),
        amount: data.amount,
        invoiceDates: invoiceDates.get(doc.id),
      };
    });

    const learned = deriveLearnedCycles(transactions);
    if (learned.length === 0) {
      console.log(`[BillingCycle] No consistent cycle found for partner ${partnerId}`);
      return { success: true, billingCycle: null };
    }

    const existingDeclared = partnerSnap.data()!.billingCycle?.declared;
    const learnedAt = Timestamp.now();
    const learnedWithTimestamp = learned.map((cycle) => ({ ...cycle, learnedAt }));
    const effective = resolveEffectiveCycles(learned, existingDeclared);

    // Declared halves are never touched here — they're set/cleared through
    // set_partner_billing_cycle (yazzbert/FiBuKI-selfhost#167), and must
    // survive a re-learn.
    await partnerRef.update({
      "billingCycle.learned": learnedWithTimestamp,
      "billingCycle.effective": effective,
      updatedAt: learnedAt,
    });

    console.log(
      `[BillingCycle] Partner ${partnerId}: ${learned.length} band(s) learned, ` +
      `sample=${txSnapshot.size}`
    );

    // Re-score already-connected files now that the cycle changed, so a
    // same-amount recurring document that was mis-attached to the wrong
    // charge (yazzbert/FiBuKI-selfhost#168) ranks correctly without
    // disturbing which files are actually connected. Awaited: callers of
    // this callable expect the re-score to have already happened by the
    // time it returns, not to race a background write.
    const partnerData = partnerSnap.data()!;
    const partnerAliases = [partnerData.name, ...(partnerData.aliases || [])].filter(Boolean);
    const sw = partnerData.scoringWeights;
    const weights = sw
      ? { amountWeight: sw.amountWeight, dateWeight: sw.dateWeight, partnerWeight: sw.partnerWeight }
      : undefined;
    await rescoreFileConnectionsForPartner(
      ctx.db,
      ctx.userId,
      partnerId,
      txSnapshot.docs,
      effective,
      weights,
      partnerAliases
    );

    // Today's callers (worker chat, agent tools) expect one flat cycle back.
    // With more than one band, surface the most confident one.
    const mostConfident = [...learned].sort(
      (a, b) => b.frequencyConfidence - a.frequencyConfidence
    )[0];
    return { success: true, billingCycle: mostConfident };
  }
);

/**
 * Map transaction id -> extracted dates of its connected files, for
 * transactions of this partner that have any. A transaction connected to
 * more than one file contributes one date per file.
 */
async function getInvoiceDates(
  userId: string,
  partnerId: string,
  txDocs: FirebaseFirestore.QueryDocumentSnapshot[]
): Promise<Map<string, Date[]>> {
  const txIds = txDocs.map((d) => d.id);
  const invoiceDates = new Map<string, Date[]>();

  // Process in batches of 30 (Firestore 'in' limit)
  for (let i = 0; i < txIds.length; i += 30) {
    const batch = txIds.slice(i, i + 30);
    const connections = await db
      .collection("fileConnections")
      .where("transactionId", "in", batch)
      .where("userId", "==", userId)
      .get();

    if (connections.empty) continue;

    const fileIds = [...new Set(connections.docs.map((d) => d.data().fileId))];

    for (let j = 0; j < fileIds.length; j += 30) {
      const fileBatch = fileIds.slice(j, j + 30);
      const files = await db
        .collection("files")
        .where("__name__", "in", fileBatch)
        .get();

      for (const fileDoc of files.docs) {
        const fileData = fileDoc.data();
        if (!fileData.extractedDate || fileData.partnerId !== partnerId) continue;

        const conn = connections.docs.find((c) => c.data().fileId === fileDoc.id);
        if (!conn) continue;

        const transactionId = conn.data().transactionId;
        const existing = invoiceDates.get(transactionId) ?? [];
        existing.push(fileData.extractedDate.toDate());
        invoiceDates.set(transactionId, existing);
      }
    }
  }

  return invoiceDates;
}
