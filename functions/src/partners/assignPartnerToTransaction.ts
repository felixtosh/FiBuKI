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
      // Remove from manualRemovals since user is explicitly re-adding
      console.log(
        `[assignPartnerToTransaction] Manual override: Partner ${effectivePartnerId} was previously rejected but user is re-adding via ${matchedBy}`
      );

      const updatedRemovals = manualRemovals.filter(
        (r: { transactionId: string }) => r.transactionId !== transactionId
      );

      await ctx.db.collection("partners").doc(effectivePartnerId).update({
        manualRemovals: updatedRemovals,
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(
        `[assignPartnerToTransaction] Removed transaction ${transactionId} from manualRemovals (${manualRemovals.length} -> ${updatedRemovals.length})`
      );
    }

    // Cancel running partner automation when user manually assigns or accepts suggestion
    if (matchedBy === "manual" || matchedBy === "suggestion") {
      cancelPartnerWorkersForTransaction(ctx.userId, transactionId).catch((err) => {
        console.error("[assignPartnerToTransaction] Failed to cancel partner workers:", err);
      });
    }

    // Capture previous partner info before overwriting (used for relearning + receipt search)
    const previousPartnerId = txData.partnerId;
    const previousPartnerType = txData.partnerType;
    const partnerChanged = previousPartnerId !== effectivePartnerId;

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

        // For manual/suggestion assignments, await pattern learning for immediate feedback
        // For AI assignments, run in background to not slow down batch operations
        if (matchedBy === "manual" || matchedBy === "suggestion") {
          console.log(`[assignPartnerToTransaction] Running pattern learning synchronously for ${matchedBy} assignment`);
          await learnPatternsForPartnersBatch(ctx.userId, [effectivePartnerId]);
          console.log(`[assignPartnerToTransaction] Pattern learning completed for partner ${effectivePartnerId}`);
        } else {
          // Run pattern learning in background for AI assignments
          learnPatternsForPartnersBatch(ctx.userId, [effectivePartnerId])
            .then(() => {
              console.log(`[assignPartnerToTransaction] Pattern learning completed (background)`);
            })
            .catch((err) => {
              console.error(`[assignPartnerToTransaction] Pattern learning failed:`, err);
            });
        }
      } catch (err) {
        console.error(`[assignPartnerToTransaction] Pattern learning failed:`, err);
        // Don't throw - assignment succeeded, just pattern learning failed
      }
    }

    // Trigger pattern relearning for the PREVIOUS partner when overwriting
    // The old partner's patterns may now be based on fewer/no manual assignments,
    // so cascade-unassign will clean up stale auto-matches
    if (previousPartnerId && previousPartnerType === "user" && partnerChanged) {
      try {
        const { learnPatternsForPartnersBatch } = await import("../matching/learnPartnerPatterns");
        learnPatternsForPartnersBatch(ctx.userId, [previousPartnerId])
          .then(() => {
            console.log(`[assignPartnerToTransaction] Previous partner ${previousPartnerId} pattern relearning completed`);
          })
          .catch((err) => {
            console.error(`[assignPartnerToTransaction] Previous partner pattern relearning failed:`, err);
          });
      } catch (err) {
        console.error(`[assignPartnerToTransaction] Failed to trigger previous partner relearning:`, err);
      }
    }

    // Trigger receipt search if transaction has no files attached AND no no-receipt category
    // This runs in background and creates a worker request for the frontend to process
    const hasFiles = txData.fileIds && txData.fileIds.length > 0;
    const hasNoReceiptCategory = !!txData.noReceiptCategoryId;

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
