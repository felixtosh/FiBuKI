/**
 * Learn a partner's billing cycle from transaction date intervals.
 *
 * Fetches the partner's transaction (and connected-file) history and hands
 * it to the pure derivation in ./billingCycle.ts. The algorithm itself lives
 * there; this file is Firestore I/O only.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  deriveLearnedCycles,
  resolveEffectiveCycles,
  type BillingCycleTransaction,
  type DerivedBillingCycle,
} from "./billingCycle";
import { rescoreFileConnectionsForPartner } from "./rescoreFileConnections";
import { checkRecurrence, isVerdictFresh, recurrenceKey, type RecurrenceCheckInput } from "./recurrenceCheck";
import { derivePartnerAliases, deriveScoringWeights } from "./transactionScoring";

/** Charges a partner needs before any cycle can be derived. */
export const MIN_BILLING_CYCLE_TRANSACTIONS = 3;

/** Newest charges considered per partner. */
const MAX_TRANSACTIONS = 100;

interface LearnBillingCycleRequest {
  partnerId: string;
}

interface LearnBillingCycleResponse {
  success: boolean;
  billingCycle: DerivedBillingCycle | null;
}

/**
 * Learn one partner's billing cycle and persist it.
 *
 * Shared by the callable below and by both auto-learn triggers — the
 * post-file-connect learn and the nightly schedule
 * (yazzbert/FiBuKI-selfhost#166) — so every path writes the same shape
 * through the same dotted-path update. The derivation is arithmetic over
 * dates and amounts; a learned cycle only becomes effective once a model has
 * confirmed the partner bills on a schedule (./recurrenceCheck.ts), since a
 * supermarket has a rhythm too. That verdict is cached on the partner.
 *
 * Verifies ownership itself and returns null for an unknown or foreign
 * partner, the same way learnPatternsForPartnersBatch skips one, so an
 * auto-learn caller cannot leak a cycle across tenants by passing an id it
 * has not checked.
 *
 * Returns the most confident learned band, or null when the history yields
 * no cycle.
 */
export async function learnBillingCycleForPartner(
  db: FirebaseFirestore.Firestore,
  userId: string,
  partnerId: string
): Promise<DerivedBillingCycle | null> {
  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();
  if (!partnerSnap.exists || partnerSnap.data()!.userId !== userId) {
    console.log(`[BillingCycle] Partner ${partnerId} not found for user ${userId}, skipping`);
    return null;
  }
  const partnerData = partnerSnap.data()!;

  // Query transactions for this partner, ordered by date. partnerId only —
  // never bankPartnerId, which reflects the bank's descriptor rather than
  // the resolved supplier and would pollute the learned cycle.
  // Newest first, so a long history is judged on its recent charges, then
  // put back in date order for the derivation.
  const txSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .orderBy("date", "desc")
    .limit(MAX_TRANSACTIONS)
    .get();
  const txDocs = [...txSnapshot.docs].reverse();

  if (txSnapshot.size < MIN_BILLING_CYCLE_TRANSACTIONS) {
    console.log(`[BillingCycle] Not enough transactions for partner ${partnerId}: ${txSnapshot.size}`);
    return null;
  }

  const invoiceDates = await getInvoiceDates(db, userId, partnerId, txDocs);
  const transactions: BillingCycleTransaction[] = txDocs.map((doc) => {
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
    return null;
  }

  const checkInput: RecurrenceCheckInput = {
    partnerName: String(partnerData.name ?? ""),
    aliases: Array.isArray(partnerData.aliases) ? partnerData.aliases.map(String) : [],
    website: typeof partnerData.website === "string" ? partnerData.website : null,
    cycles: learned,
    charges: txSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        date: data.date.toDate(),
        amount: data.amount,
        description: [data.name, data.partner, data.reference].filter(Boolean).join(" / ").slice(0, 120),
      };
    }),
  };
  const cachedVerdict = partnerData.billingCycle?.recurrence;
  const freshVerdict = isVerdictFresh(cachedVerdict, recurrenceKey(checkInput))
    ? null
    : await checkRecurrence(userId, partnerId, checkInput);
  // A failed check keeps the last answer for this same question rather than
  // flipping a confirmed subscription off for a night.
  const verdict = freshVerdict
    ?? (cachedVerdict?.key === recurrenceKey(checkInput) ? cachedVerdict : null);
  const confirmed = verdict?.recurring === true;

  const existingDeclared = partnerData.billingCycle?.declared;
  const learnedAt = Timestamp.now();
  const learnedWithTimestamp = learned.map((cycle) => ({ ...cycle, learnedAt }));
  // Unconfirmed learned bands stay on record but act on nothing: matching,
  // the "document missing" marker and the MCP all read `effective`.
  const effective = resolveEffectiveCycles(learned, existingDeclared)
    .filter((cycle) => confirmed || cycle.source === "declared");

  // Declared halves are never touched here — they're set/cleared through
  // set_partner_billing_cycle (yazzbert/FiBuKI-selfhost#167), and must
  // survive a re-learn.
  await partnerRef.update({
    "billingCycle.learned": learnedWithTimestamp,
    "billingCycle.effective": effective,
    ...(freshVerdict ? { "billingCycle.recurrence": freshVerdict } : {}),
    updatedAt: learnedAt,
  });

  console.log(
    `[BillingCycle] Partner ${partnerId}: ${learned.length} band(s) learned, ` +
    `recurring=${verdict ? verdict.recurring : "unchecked"}, sample=${txSnapshot.size}`
  );

  // Re-score already-connected files now that the cycle changed, so a
  // same-amount recurring document that was mis-attached to the wrong
  // charge (yazzbert/FiBuKI-selfhost#168) ranks correctly without
  // disturbing which files are actually connected. Awaited (not
  // fire-and-forget): callers expect the re-score to have already happened
  // by the time this returns. Wrapped in try/catch, not left to propagate:
  // the billing-cycle write above has already committed, so a re-score
  // failure (e.g. a connection deleted by a concurrent session between the
  // query and the write) must not turn a successful learn into a failure.
  try {
    await rescoreFileConnectionsForPartner(
      db,
      userId,
      partnerId,
      txDocs,
      effective,
      deriveScoringWeights(partnerData),
      await derivePartnerAliases(db, partnerData)
    );
  } catch (error) {
    console.warn(`[BillingCycle] Re-score failed for partner ${partnerId}:`, error);
  }

  // Today's callers (worker chat, agent tools) expect one flat cycle back.
  // With more than one band, surface the most confident one.
  if (!confirmed) return null;
  return [...learned].sort((a, b) => b.frequencyConfidence - a.frequencyConfidence)[0];
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

    // Verify partner ownership. learnBillingCycleForPartner re-checks it (its
    // auto-learn callers have no ownership check of their own), but only this
    // path can tell the caller apart from "learned nothing".
    const partnerSnap = await ctx.db.collection("partners").doc(partnerId).get();
    if (!partnerSnap.exists || partnerSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("not-found", "Partner not found");
    }

    const billingCycle = await learnBillingCycleForPartner(ctx.db, ctx.userId, partnerId);
    return { success: true, billingCycle };
  }
);

/**
 * Map transaction id -> extracted dates of its connected files, for
 * transactions of this partner that have any. A transaction connected to
 * more than one file contributes one date per file.
 */
async function getInvoiceDates(
  db: FirebaseFirestore.Firestore,
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
