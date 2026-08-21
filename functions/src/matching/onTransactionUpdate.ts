import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, DocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import {
  matchTransactionToCategories,
  shouldAutoApplyCategory,
  isEligibleForCategoryMatching,
  CategoryData,
  TransactionData,
  CategoryMatchOptions,
  CategoryMatchRule,
} from "../utils/category-matcher";
import { AutomationMeta } from "../automation/types";
import { isPassiveMode } from "../utils/checkAutomationMode";
import {
  documentationStateChanged,
  shouldRecomputeDocumentationState,
} from "../documents/documentationState";
import { deriveForTransaction } from "../documents/syncDocumentationState";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "onTransactionUpdate",
  name: "Transaction Update Handler",
  description:
    "Syncs isComplete and documentationState, learns resolution preferences, and triggers category matching on partner assignment",
  trigger: {
    type: "document_update",
    collection: "transactions",
  },
  effects: [
    {
      entity: "transaction",
      fields: [
        "isComplete",
        "documentationState",
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

    // === SYNC isComplete FLAG AND documentationState ===
    // isComplete = true when: fileIds.length > 0 OR noReceiptCategoryId is set.
    // Its meaning is deliberately unchanged by #104 — "has some documentation".
    // documentationState is the additive fact that says WHAT the documentation
    // is, so a green line can still be a bookkeeping gap and be found.
    const fileIdsChanged = JSON.stringify(before.fileIds) !== JSON.stringify(after.fileIds);
    const categoryChanged = before.noReceiptCategoryId !== after.noReceiptCategoryId;

    const syncUpdates: Record<string, unknown> = {};

    if (fileIdsChanged || categoryChanged) {
      const hasFiles = (after.fileIds?.length ?? 0) > 0;
      const hasCategory = !!after.noReceiptCategoryId;
      const shouldBeComplete = hasFiles || hasCategory;

      if (after.isComplete !== shouldBeComplete) {
        syncUpdates.isComplete = shouldBeComplete;
      }
    }

    if (shouldRecomputeDocumentationState(before, after)) {
      const derivedState = await deriveForTransaction(db, after);
      if (documentationStateChanged(after.documentationState, derivedState)) {
        syncUpdates.documentationState = derivedState;
      }
    }

    if (Object.keys(syncUpdates).length > 0) {
      await event.data!.after.ref.update({
        ...syncUpdates,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(
        `[onTransactionUpdate] Synced ${Object.keys(syncUpdates).join(", ")} for ${transactionId}`
      );

      // Return early only when isComplete moved — that is the flag everything
      // below reads, and the re-trigger will run this function again with it
      // settled. A documentationState-only write must NOT return: the partner
      // automations belong to THIS event, and the re-trigger sees an unchanged
      // partnerId and would skip them entirely.
      if (syncUpdates.isComplete !== undefined) return;
    }
    // === END isComplete / documentationState SYNC ===

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

    // Skip automations for auto-matched transactions — pattern learning pipeline
    // (rematchUnassignedTransactions) handles these in bulk. Running receipt search
    // and category matching for each auto-assigned tx would create N redundant invocations.
    if (after.partnerMatchedBy === "auto") {
      console.log(`[onTransactionUpdate] Skipping automations for auto-matched tx ${transactionId}`);
      return;
    }

    const userId = after.userId;
    const hasFiles = after.fileIds && after.fileIds.length > 0;
    const hasCategory = !!after.noReceiptCategoryId;

    console.log(
      `Partner ${after.partnerId} assigned to transaction ${transactionId}, triggering automations`
    );

    // Fetch partner doc once — reused by reconciliation check + category matching
    let partnerDoc: DocumentSnapshot | null = null;
    try {
      partnerDoc = await db.collection("partners").doc(after.partnerId).get();
    } catch (err) {
      console.error(`[onTransactionUpdate] Failed to fetch partner ${after.partnerId}:`, err);
    }

    // === RECONCILIATION CHECK ===
    // When a source partner is assigned, check if this bank tx pays a linked card
    if (partnerDoc?.exists) {
      const identitySourceField = partnerDoc.data()!.identitySourceField as string | undefined;

      if (identitySourceField?.startsWith("source:")) {
        const cardSourceId = identitySourceField.replace("source:", "");
        console.log(
          `[onTransactionUpdate] Source partner detected for tx ${transactionId}, ` +
          `checking reconciliation with card source ${cardSourceId}`
        );

        // Fire-and-forget reconciliation (don't block other automations)
        import("../reconciliation/processReconciliation")
          .then(({ tryReconcileTransaction }) =>
            tryReconcileTransaction(userId, transactionId, {
              amount: after.amount,
              date: after.date,
              name: after.name || "",
              sourceId: after.sourceId,
              noReceiptCategoryTemplateId: after.noReceiptCategoryTemplateId || null,
              partnerId: after.partnerId || null,
            }, cardSourceId)
          )
          .then(() => {
            console.log(`[onTransactionUpdate] Reconciliation check complete for ${transactionId}`);
          })
          .catch((err) => {
            console.error(`[onTransactionUpdate] Reconciliation check failed:`, err);
          });
      }
    }
    // === END RECONCILIATION CHECK ===

    // Queue receipt search if transaction has no files AND no no-receipt category
    // Transactions with a no-receipt category are considered complete
    // Skip in passive mode (AI-powered search is opt-in only)
    if (!hasFiles && !hasCategory) {
      const passive = await isPassiveMode(userId);
      if (passive) {
        console.log(`[onTransactionUpdate] Passive mode — skipping receipt search for ${transactionId}`);
      } else {
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

      // Use partner's category match rules (from already-fetched partnerDoc)
      const options: CategoryMatchOptions = {};
      if (partnerDoc?.exists) {
        const partnerData = partnerDoc.data();
        if (partnerData?.categoryMatchRules && partnerData.categoryMatchRules.length > 0) {
          options.partnerCategoryRules = partnerData.categoryMatchRules as CategoryMatchRule[];
          console.log(`Loaded ${options.partnerCategoryRules.length} category rules for partner ${after.partnerId}`);
        }
      }

      // Match transaction to categories
      const matches = matchTransactionToCategories(
        transaction,
        categories,
        categoryManualRemovals,
        options
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

          // Log category auto-match to activity log
          updates.automationHistory = FieldValue.arrayUnion({
            type: "category_matched",
            ranAt: Timestamp.now(),
            status: "completed",
            actor: "auto",
            level: "outcome" as const,
            categoryName: topMatch.templateId,
            confidence: topMatch.confidence,
            summary: `Category "${topMatch.templateId}" auto-assigned (${topMatch.confidence}%)`,
          });

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
