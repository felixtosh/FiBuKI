/**
 * Assign a partner to a transaction
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { cancelPartnerWorkersForTransaction } from "../utils/cancelWorkers";

interface AssignPartnerToTransactionRequest {
  transactionId: string;
  partnerId: string;
  partnerType: "global" | "user";
  matchedBy: "manual" | "suggestion" | "auto" | "ai";
  confidence?: number;
}

interface AssignPartnerToTransactionResponse {
  success: boolean;
}

export const assignPartnerToTransactionCallable = createCallable<
  AssignPartnerToTransactionRequest,
  AssignPartnerToTransactionResponse
>(
  { name: "assignPartnerToTransaction" },
  async (ctx, request) => {
    const { transactionId, partnerId, partnerType, matchedBy, confidence } = request;

    if (!transactionId) {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }
    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }
    if (!partnerType) {
      throw new HttpsError("invalid-argument", "partnerType is required");
    }
    if (!matchedBy) {
      throw new HttpsError("invalid-argument", "matchedBy is required");
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

    // Verify partner exists - check correct collection based on type
    const collectionName = partnerType === "global" ? "globalPartners" : "partners";
    const partnerRef = ctx.db.collection(collectionName).doc(partnerId);
    const partnerSnap = await partnerRef.get();

    if (!partnerSnap.exists) {
      throw new HttpsError("not-found", "Partner not found");
    }

    // For user partners, verify ownership
    const partnerData = partnerSnap.data()!;
    if (partnerType === "user" && partnerData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Partner access denied");
    }

    // Convert global partner to local partner
    // This creates a user-owned copy and allows pattern learning
    let effectivePartnerId = partnerId;
    let effectivePartnerType: "global" | "user" = partnerType;

    if (partnerType === "global") {
      try {
        const { createLocalPartnerFromGlobal } = await import(
          "../matching/createLocalPartnerFromGlobal"
        );
        effectivePartnerId = await createLocalPartnerFromGlobal(ctx.userId, partnerId);
        effectivePartnerType = "user";
        console.log(
          `[assignPartnerToTransaction] Converted global partner ${partnerId} to local ${effectivePartnerId}`
        );
      } catch (err) {
        console.error(`[assignPartnerToTransaction] Failed to convert global partner:`, err);
        // Continue with global partner if conversion fails
      }
    }

    // Re-fetch partner data if we converted to local (for manualRemovals check)
    let effectivePartnerData = partnerData;
    if (effectivePartnerId !== partnerId) {
      const localPartnerSnap = await ctx.db.collection("partners").doc(effectivePartnerId).get();
      if (localPartnerSnap.exists) {
        effectivePartnerData = localPartnerSnap.data()!;
      }
    }

    // Check if user previously rejected this partner for this transaction
    // Only block for auto/ai matches - manual/suggestion assignments are deliberate user overrides
    // manualRemovals is an array of { transactionId: string, ... }
    const manualRemovals = effectivePartnerData.manualRemovals || [];
    const wasRejected = manualRemovals.some(
      (r: { transactionId: string }) => r.transactionId === transactionId
    );

    if (wasRejected && (matchedBy === "auto" || matchedBy === "ai")) {
      console.log(
        `[assignPartnerToTransaction] Blocked: Partner ${partnerId} was previously rejected for transaction ${transactionId} (matchedBy: ${matchedBy})`
      );
      throw new HttpsError(
        "failed-precondition",
        `Partner was previously rejected for this transaction. To reassign, first remove it from the partner's rejection list.`
      );
    }

    if (wasRejected) {
      // Manual/suggestion override of a previously rejected partner
      console.log(
        `[assignPartnerToTransaction] Manual override: Partner ${partnerId} was previously rejected but user is re-adding via ${matchedBy}`
      );
    }

    // Cancel running partner automation when user manually assigns or accepts suggestion
    if (matchedBy === "manual" || matchedBy === "suggestion") {
      cancelPartnerWorkersForTransaction(ctx.userId, transactionId).catch((err) => {
        console.error("[assignPartnerToTransaction] Failed to cancel partner workers:", err);
      });
    }

    // Update transaction with partner assignment
    await transactionRef.update({
      partnerId: effectivePartnerId,
      partnerType: effectivePartnerType,
      partnerMatchedBy: matchedBy,
      partnerMatchConfidence: confidence ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[assignPartnerToTransaction] Assigned partner ${effectivePartnerId} to transaction ${transactionId}`, {
      userId: ctx.userId,
      partnerType: effectivePartnerType,
      originalPartnerType: partnerType,
      matchedBy,
    });

    // Trigger pattern learning for user/AI assignments
    // Manual, suggestion clicks, and AI assignments should inform pattern learning
    // Note: effectivePartnerType is always "user" now (global partners are converted)
    if ((matchedBy === "manual" || matchedBy === "suggestion" || matchedBy === "ai") && effectivePartnerType === "user") {
      try {
        const { learnPatternsForPartnersBatch } = await import("../matching/learnPartnerPatterns");
        // Run pattern learning in background (don't await)
        learnPatternsForPartnersBatch(ctx.userId, [effectivePartnerId])
          .then((results) => {
            console.log(`[assignPartnerToTransaction] Pattern learning completed:`, results);
          })
          .catch((err) => {
            console.error(`[assignPartnerToTransaction] Pattern learning failed:`, err);
          });
      } catch (err) {
        console.error(`[assignPartnerToTransaction] Failed to start pattern learning:`, err);
      }
    }

    // Trigger receipt search if transaction has no files attached AND no no-receipt category
    // This runs in background and creates a worker request for the frontend to process
    const hasFiles = txData.fileIds && txData.fileIds.length > 0;
    const hasNoReceiptCategory = !!txData.noReceiptCategoryId;
    const previousPartnerId = txData.partnerId;
    const partnerChanged = previousPartnerId !== effectivePartnerId;

    // Skip receipt search if transaction is already complete (has file or no-receipt category)
    if (!hasFiles && !hasNoReceiptCategory && (partnerChanged || !previousPartnerId)) {
      try {
        const { queueReceiptSearchForTransaction } = await import(
          "../workers/runReceiptSearchForTransaction"
        );

        // Queue receipt search in background (don't await)
        queueReceiptSearchForTransaction({
          transactionId,
          userId: ctx.userId,
          partnerId: effectivePartnerId,
        })
          .then((result) => {
            console.log(`[assignPartnerToTransaction] Receipt search queued:`, result);
          })
          .catch((err) => {
            console.error(`[assignPartnerToTransaction] Receipt search queue failed:`, err);
          });
      } catch (err) {
        console.error(`[assignPartnerToTransaction] Failed to queue receipt search:`, err);
      }
    }

    return { success: true };
  }
);
