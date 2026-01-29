import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  matchTransactionToCategories,
  shouldAutoApplyCategory,
  isEligibleForCategoryMatching,
  CategoryData,
  TransactionData,
} from "../utils/category-matcher";
import { AutomationMeta } from "../automation/types";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "onTransactionUpdate",
  name: "Transaction Update Handler",
  description:
    "Syncs isComplete flag, learns resolution preferences, and triggers category matching on partner assignment",
  trigger: {
    type: "document_update",
    collection: "transactions",
  },
  effects: [
    {
      entity: "transaction",
      fields: [
        "isComplete",
        "noReceiptCategoryId",
        "noReceiptCategoryTemplateId",
        "noReceiptCategoryConfidence",
        "noReceiptCategoryMatchedBy",
        "categorySuggestions",
      ],
      action: "update",
    },
    {
      entity: "partner",
      fields: ["resolutionPreference"],
      action: "update",
    },
    {
      entity: "noReceiptCategory",
      fields: ["matchedPartnerIds"],
      action: "update",
    },
    {
      entity: "workerRequest",
      fields: ["workerType", "initialPrompt"],
      action: "create",
    },
  ],
  learns: [
    {
      entity: "partner",
      fields: ["resolutionPreference"],
      description:
        "Tracks file vs no-receipt resolution patterns to predict future behavior",
    },
  ],
  config: {
    categoryAutoApplyThreshold: 89,
  },
  icon: "Zap",
  category: "sync",
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const db = getFirestore();

/**
 * Triggered when a transaction is updated.
 *
 * Handles:
 * 1. isComplete sync - keeps flag in sync with fileIds/noReceiptCategoryId
 * 2. Partner automations - triggers receipt search and category matching
 */
export const onTransactionUpdate = onDocumentUpdated(
  {
    document: "transactions/{transactionId}",
    region: "europe-west1",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const transactionId = event.params.transactionId;

    if (!before || !after) return;

    // === SYNC isComplete FLAG ===
    // isComplete = true when: fileIds.length > 0 OR noReceiptCategoryId is set
    const fileIdsChanged = JSON.stringify(before.fileIds) !== JSON.stringify(after.fileIds);
    const categoryChanged = before.noReceiptCategoryId !== after.noReceiptCategoryId;

    if (fileIdsChanged || categoryChanged) {
      const hasFiles = (after.fileIds?.length ?? 0) > 0;
      const hasCategory = !!after.noReceiptCategoryId;
      const shouldBeComplete = hasFiles || hasCategory;

      if (after.isComplete !== shouldBeComplete) {
        await event.data!.after.ref.update({
          isComplete: shouldBeComplete,
          updatedAt: FieldValue.serverTimestamp(),
        });
        console.log(`[onTransactionUpdate] Synced isComplete=${shouldBeComplete} for ${transactionId}`);
        // Return early - the update will trigger this function again with correct isComplete
        return;
      }
    }
    // === END isComplete SYNC ===

    // === LEARN RESOLUTION PREFERENCE ===
    // When transaction is marked complete, update partner's resolution preference
    const wasCompleted = !before.isComplete && after.isComplete;
    const completionPartnerId = after.partnerId;

    if (wasCompleted && completionPartnerId && after.partnerType === "user") {
      const completionHasFiles = (after.fileIds?.length ?? 0) > 0;
      const completionHasCategory = !!after.noReceiptCategoryId;

      // Only learn if exactly one resolution method (not both)
      // This avoids double-counting edge cases
      if (
        (completionHasFiles && !completionHasCategory) ||
        (!completionHasFiles && completionHasCategory)
      ) {
        try {
          const { updatePartnerResolutionStats } = await import(
            "./learnPartnerResolution"
          );
          await updatePartnerResolutionStats(
            after.userId,
            completionPartnerId,
            completionHasFiles ? "file" : "no_receipt",
            after.noReceiptCategoryId || null
          );
        } catch (err) {
          console.error(
            `[onTransactionUpdate] Failed to update resolution stats:`,
            err
          );
        }
      }
    }
    // === END RESOLUTION LEARNING ===

    // === PARTNER CHANGE AUTOMATIONS ===
    // Only trigger when partnerId is newly assigned (was null, now has value)
    // OR when partnerId changed to a different partner
    const partnerWasAssigned = !before.partnerId && after.partnerId;
    const partnerChanged = before.partnerId !== after.partnerId && after.partnerId;

    if (!partnerWasAssigned && !partnerChanged) {
      return;
    }

    const userId = after.userId;
    const hasFiles = after.fileIds && after.fileIds.length > 0;
    const hasCategory = !!after.noReceiptCategoryId;

    console.log(
      `Partner ${after.partnerId} assigned to transaction ${transactionId}, triggering automations`
    );

    // Queue receipt search if transaction has no files AND no no-receipt category
    // Transactions with a no-receipt category are considered complete
    if (!hasFiles && !hasCategory) {
      try {
        const { queueReceiptSearchForTransaction } = await import(
          "../workers/runReceiptSearchForTransaction"
        );

        queueReceiptSearchForTransaction({
          transactionId,
          userId,
          partnerId: after.partnerId,
        })
          .then((result) => {
            if (result.skipped) {
              console.log(`[onTransactionUpdate] Receipt search skipped: ${result.skipReason}`);
            } else {
              console.log(`[onTransactionUpdate] Receipt search queued for ${transactionId}`);
            }
          })
          .catch((err) => {
            console.error(`[onTransactionUpdate] Failed to queue receipt search:`, err);
          });
      } catch (err) {
        console.error(`[onTransactionUpdate] Failed to import receipt search module:`, err);
      }
    }

    // Skip category matching if already has category or files
    if (hasCategory || hasFiles) {
      return;
    }

    try {
      // Get all active categories for this user
      const categoriesSnapshot = await db
        .collection("noReceiptCategories")
        .where("userId", "==", userId)
        .where("isActive", "==", true)
        .get();

      if (categoriesSnapshot.empty) {
        console.log(`No active categories found for user ${userId}`);
        return;
      }

      // Build map of categoryId -> Set<transactionIds> for manual removals
      const categoryManualRemovals = new Map<string, Set<string>>();

      const categories: CategoryData[] = categoriesSnapshot.docs.map((doc) => {
        const data = doc.data();

        const removals = data.manualRemovals || [];
        if (removals.length > 0) {
          categoryManualRemovals.set(
            doc.id,
            new Set(removals.map((r: { transactionId: string }) => r.transactionId))
          );
        }

        return {
          id: doc.id,
          userId: data.userId,
          templateId: data.templateId,
          name: data.name,
          matchedPartnerIds: data.matchedPartnerIds || [],
          learnedPatterns: data.learnedPatterns || [],
          manualRemovals: removals,
          transactionCount: data.transactionCount || 0,
          isActive: data.isActive,
        };
      });

      // Build transaction data for matching
      const transaction: TransactionData = {
        id: transactionId,
        partner: after.partner || null,
        partnerId: after.partnerId || null,
        name: after.name || "",
        reference: after.reference || null,
        noReceiptCategoryId: after.noReceiptCategoryId || null,
        fileIds: after.fileIds || [],
      };

      if (!isEligibleForCategoryMatching(transaction)) {
        return;
      }

      // Match transaction to categories
      const matches = matchTransactionToCategories(
        transaction,
        categories,
        categoryManualRemovals
      );

      if (matches.length > 0) {
        const topMatch = matches[0];
        const updates: Record<string, unknown> = {
          categorySuggestions: matches.map((m) => ({
            categoryId: m.categoryId,
            templateId: m.templateId,
            confidence: m.confidence,
            source: m.source,
          })),
          updatedAt: FieldValue.serverTimestamp(),
        };

        if (shouldAutoApplyCategory(topMatch.confidence)) {
          updates.noReceiptCategoryId = topMatch.categoryId;
          updates.noReceiptCategoryTemplateId = topMatch.templateId;
          updates.noReceiptCategoryConfidence = topMatch.confidence;
          updates.noReceiptCategoryMatchedBy = "auto";
          updates.isComplete = true;

          // Also link partner to category
          const category = categories.find((c) => c.id === topMatch.categoryId);
          if (category && after.partnerId && !category.matchedPartnerIds.includes(after.partnerId)) {
            await db.collection("noReceiptCategories").doc(topMatch.categoryId).update({
              matchedPartnerIds: FieldValue.arrayUnion(after.partnerId),
              updatedAt: FieldValue.serverTimestamp(),
            });
            console.log(`Linked partner ${after.partnerId} to category ${topMatch.templateId}`);
          }

          console.log(
            `Auto-matched transaction ${transactionId} to category ${topMatch.templateId} (${topMatch.confidence}%)`
          );
        } else {
          console.log(
            `Added ${matches.length} category suggestions to transaction ${transactionId}`
          );
        }

        await db.collection("transactions").doc(transactionId).update(updates);
      }
    } catch (error) {
      console.error(
        `Error re-matching categories for transaction ${transactionId}:`,
        error
      );
    }
  }
);
