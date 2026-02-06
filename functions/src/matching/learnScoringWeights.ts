/**
 * Learn per-partner scoring weights from match history.
 *
 * Analyzes fileConnections that have scoreBreakdown stored:
 * - Correct matches: connections that were never disconnected/rejected
 * - Incorrect matches: connections whose file was later rejected from the transaction
 *
 * Computes weight adjustments based on which scoring factors discriminate
 * correct from incorrect matches.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

const db = getFirestore();

/** Minimum connections with scoreBreakdown needed to compute weights */
const MIN_SAMPLE_SIZE = 5;

interface LearnScoringWeightsRequest {
  partnerId: string;
}

interface LearnScoringWeightsResponse {
  success: boolean;
  weights: {
    amountWeight: number;
    dateWeight: number;
    partnerWeight: number;
    sampleSize: number;
  } | null;
}

export const learnScoringWeightsCallable = createCallable<
  LearnScoringWeightsRequest,
  LearnScoringWeightsResponse
>(
  { name: "learnScoringWeights" },
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

    // Get all transactions for this partner to know which txIds to filter connections
    const txSnap = await ctx.db
      .collection("transactions")
      .where("userId", "==", ctx.userId)
      .where("partnerId", "==", partnerId)
      .select("rejectedFileIds", "rejectedFiles")
      .limit(1000)
      .get();

    const txIds = new Set(txSnap.docs.map((d) => d.id));

    if (txIds.size === 0) {
      return { success: true, weights: null };
    }

    // Build rejection set
    const rejectedPairs = new Set<string>();
    for (const doc of txSnap.docs) {
      const data = doc.data();
      for (const id of (data.rejectedFileIds || []) as string[]) {
        rejectedPairs.add(`${id}:${doc.id}`);
      }
      for (const r of (data.rejectedFiles || []) as Array<{ fileId: string }>) {
        rejectedPairs.add(`${r.fileId}:${doc.id}`);
      }
    }

    // Get fileConnections for these transactions (in batches of 30)
    const txIdArray = [...txIds];
    const correctBreakdowns: Array<{ amount: number; date: number; partner: number }> = [];
    const incorrectBreakdowns: Array<{ amount: number; date: number; partner: number }> = [];

    for (let i = 0; i < txIdArray.length; i += 30) {
      const batch = txIdArray.slice(i, i + 30);
      const connSnap = await db
        .collection("fileConnections")
        .where("transactionId", "in", batch)
        .where("userId", "==", ctx.userId)
        .get();

      for (const doc of connSnap.docs) {
        const conn = doc.data();
        if (!conn.scoreBreakdown) continue; // Only connections with breakdown

        const breakdown = conn.scoreBreakdown as {
          amount: number;
          date: number;
          partner: number;
        };

        const pairKey = `${conn.fileId}:${conn.transactionId}`;
        if (rejectedPairs.has(pairKey)) {
          incorrectBreakdowns.push(breakdown);
        } else {
          correctBreakdowns.push(breakdown);
        }
      }
    }

    const totalSamples = correctBreakdowns.length + incorrectBreakdowns.length;
    if (totalSamples < MIN_SAMPLE_SIZE) {
      console.log(
        `[ScoringWeights] Not enough data for partner ${partnerId}: ` +
        `${totalSamples} samples (need ${MIN_SAMPLE_SIZE})`
      );
      return { success: true, weights: null };
    }

    // Compute average factor values for correct vs incorrect
    const avgCorrect = computeAverages(correctBreakdowns);
    const avgIncorrect = computeAverages(incorrectBreakdowns);

    // Compute weight adjustments
    // If a factor is high in correct AND incorrect matches, it's not discriminating → keep 1.0
    // If a factor is high in correct but low in incorrect, it's discriminating → boost weight
    // If a factor is low in correct but high in incorrect, it's misleading → reduce weight
    const weights = {
      amountWeight: computeWeight(avgCorrect.amount, avgIncorrect.amount),
      dateWeight: computeWeight(avgCorrect.date, avgIncorrect.date),
      partnerWeight: computeWeight(avgCorrect.partner, avgIncorrect.partner),
      sampleSize: totalSamples,
      updatedAt: Timestamp.now(),
    };

    // Store on partner
    await partnerRef.update({
      scoringWeights: weights,
      updatedAt: Timestamp.now(),
    });

    console.log(
      `[ScoringWeights] Partner ${partnerId}: ` +
      `amt=${weights.amountWeight.toFixed(2)} date=${weights.dateWeight.toFixed(2)} ` +
      `partner=${weights.partnerWeight.toFixed(2)} (${totalSamples} samples, ` +
      `${correctBreakdowns.length} correct, ${incorrectBreakdowns.length} incorrect)`
    );

    return { success: true, weights };
  }
);

function computeAverages(
  breakdowns: Array<{ amount: number; date: number; partner: number }>
): { amount: number; date: number; partner: number } {
  if (breakdowns.length === 0) {
    return { amount: 0, date: 0, partner: 0 };
  }
  const sum = breakdowns.reduce(
    (acc, b) => ({
      amount: acc.amount + b.amount,
      date: acc.date + b.date,
      partner: acc.partner + b.partner,
    }),
    { amount: 0, date: 0, partner: 0 }
  );
  return {
    amount: sum.amount / breakdowns.length,
    date: sum.date / breakdowns.length,
    partner: sum.partner / breakdowns.length,
  };
}

/**
 * Compute weight adjustment based on discrimination power.
 * Returns a value between 0.5 (factor is misleading) and 1.5 (factor is very discriminating).
 */
function computeWeight(avgCorrect: number, avgIncorrect: number): number {
  // If no incorrect data, default to 1.0 (no adjustment needed)
  if (avgIncorrect === 0 && avgCorrect === 0) return 1.0;

  // If factor is high in correct but low/zero in incorrect → very discriminating
  if (avgIncorrect === 0) return Math.min(1.5, 1.0 + avgCorrect / 40);

  // If factor is high in incorrect but low in correct → misleading
  if (avgCorrect === 0) return Math.max(0.5, 1.0 - avgIncorrect / 40);

  // Compare ratio
  const ratio = avgCorrect / avgIncorrect;

  if (ratio > 2.0) return 1.3; // Factor strongly discriminates → boost
  if (ratio > 1.5) return 1.15; // Factor moderately discriminates → slight boost
  if (ratio < 0.5) return 0.7; // Factor is misleading → reduce
  if (ratio < 0.75) return 0.85; // Factor is slightly misleading → slight reduce

  return 1.0; // Factor is similar in both → no adjustment
}
