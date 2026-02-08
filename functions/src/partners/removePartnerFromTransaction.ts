/**
 * Remove partner assignment from a transaction
 * Records false positives (auto-assigned transactions that user removed) for pattern relearning
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface RemovePartnerFromTransactionRequest {
  transactionId: string;
}

interface RemovePartnerFromTransactionResponse {
  success: boolean;
}

const MAX_MANUAL_REMOVALS = 50; // Cap to prevent unbounded growth

export const removePartnerFromTransactionCallable = createCallable<
  RemovePartnerFromTransactionRequest,
  RemovePartnerFromTransactionResponse
>(
  { name: "removePartnerFromTransaction" },
  async (ctx, request) => {
    const { transactionId } = request;

    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }

    // Verify transaction ownership
    const transactionRef = ctx.db.collection("transactions").doc(transactionId);
    const transactionSnap = await transactionRef.get();

    if (!transactionSnap.exists) {
      throw new HttpsError("not-found", "Transaction not found");
    }

    const txData = transactionSnap.data()!;
    if (txData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    const previousPartnerId = txData.partnerId;
    const previousMatchedBy = txData.partnerMatchedBy;
    const previousPartnerType = txData.partnerType;

    // Clear partner assignment
    await transactionRef.update({
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[removePartnerFromTransaction] Removed partner from transaction ${transactionId}`, {
      userId: ctx.userId,
      previousPartnerId,
      previousMatchedBy,
    });

    // Record as false positive if this was an auto/AI-matched user partner
    // This helps pattern learning avoid the same mistake
    const wasAutoAssigned = previousMatchedBy === "auto" || previousMatchedBy === "ai";
    if (previousPartnerId && previousPartnerType === "user" && wasAutoAssigned) {
      try {
        const partnerRef = ctx.db.collection("partners").doc(previousPartnerId);
        const partnerSnap = await partnerRef.get();

        if (partnerSnap.exists && partnerSnap.data()?.userId === ctx.userId) {
          // Add to manualRemovals (false positives list)
          const existingRemovals = partnerSnap.data()?.manualRemovals || [];

          // Check if already recorded
          const alreadyRecorded = existingRemovals.some(
            (r: { transactionId: string }) => r.transactionId === transactionId
          );

          if (!alreadyRecorded) {
            const removalRecord = {
              transactionId,
              removedAt: Timestamp.now(),
              partner: txData.partner || null,
              name: txData.name || "",
            };

            // Trim to max size, keeping most recent
            const updatedRemovals = [...existingRemovals, removalRecord].slice(-MAX_MANUAL_REMOVALS);

            await partnerRef.update({
              manualRemovals: updatedRemovals,
              updatedAt: FieldValue.serverTimestamp(),
            });

            console.log(`[removePartnerFromTransaction] Recorded false positive for partner ${previousPartnerId}`);
          }
        }
      } catch (err) {
        console.error(`[removePartnerFromTransaction] Failed to record false positive:`, err);
        // Don't fail the removal just because false positive recording failed
      }
    }

    // Trigger pattern relearning for ANY user partner removal (not just auto-assigned)
    // Manual assignments are the training data for patterns — removing them must trigger relearning
    // so that stale auto-matches from the old patterns get cascade-unassigned
    if (previousPartnerId && previousPartnerType === "user") {
      try {
        const { learnPatternsForPartnersBatch } = await import("../matching/learnPartnerPatterns");
        learnPatternsForPartnersBatch(ctx.userId, [previousPartnerId])
          .then((results) => {
            console.log(`[removePartnerFromTransaction] Pattern relearning completed:`, results);
          })
          .catch((err) => {
            console.error(`[removePartnerFromTransaction] Pattern relearning failed:`, err);
          });
      } catch (err) {
        console.error(`[removePartnerFromTransaction] Failed to trigger pattern relearning:`, err);
      }
    }

    return { success: true };
  }
);
