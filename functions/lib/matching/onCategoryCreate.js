"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onCategoryCreate = exports.AUTOMATION_META = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const category_matcher_1 = require("../utils/category-matcher");
// =============================================================================
// AUTOMATION METADATA
// =============================================================================
exports.AUTOMATION_META = {
    id: "onCategoryCreate",
    name: "Re-match on Category Create",
    description: "Re-evaluates unmatched transactions when a new no-receipt category is created",
    trigger: {
        type: "document_create",
        collection: "noReceiptCategories",
    },
    effects: [
        {
            entity: "transaction",
            fields: [
                "noReceiptCategoryId",
                "noReceiptCategoryTemplateId",
                "noReceiptCategoryConfidence",
                "noReceiptCategoryMatchedBy",
                "categorySuggestions",
                "isComplete",
            ],
            action: "update",
        },
    ],
    config: {
        autoApplyThreshold: 89,
        maxTransactionsPerRun: 500,
    },
    icon: "FolderOpen",
    category: "matching",
};
// =============================================================================
// IMPLEMENTATION
// =============================================================================
const db = (0, firestore_2.getFirestore)();
/**
 * Triggered when a new no-receipt category is created.
 * Re-matches unmatched transactions for that user.
 */
exports.onCategoryCreate = (0, firestore_1.onDocumentCreated)({
    document: "noReceiptCategories/{categoryId}",
    region: "europe-west1",
}, async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const categoryData = snapshot.data();
    const categoryId = snapshot.id;
    const userId = categoryData.userId;
    console.log(`New category created: ${categoryData.name} (${categoryId}) for user ${userId}`);
    try {
        // Get transactions without category and without files for this user
        const unmatchedSnapshot = await db
            .collection("transactions")
            .where("userId", "==", userId)
            .where("noReceiptCategoryId", "==", null)
            .limit(500)
            .get();
        if (unmatchedSnapshot.empty) {
            console.log(`No unmatched transactions found for user ${userId}`);
            return;
        }
        console.log(`Found ${unmatchedSnapshot.size} unmatched transactions`);
        // Get all active categories for matching (including the new one)
        const categoriesSnapshot = await db
            .collection("noReceiptCategories")
            .where("userId", "==", userId)
            .where("isActive", "==", true)
            .get();
        // Build map of categoryId -> Set<transactionIds> for manual removals
        const categoryManualRemovals = new Map();
        const categories = categoriesSnapshot.docs.map((doc) => {
            const data = doc.data();
            // Track manual removals for this category
            const removals = data.manualRemovals || [];
            if (removals.length > 0) {
                categoryManualRemovals.set(doc.id, new Set(removals.map((r) => r.transactionId)));
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
        // Process each unmatched transaction
        const batch = db.batch();
        let batchCount = 0;
        let autoMatched = 0;
        let suggestionsAdded = 0;
        const BATCH_LIMIT = 500;
        for (const txDoc of unmatchedSnapshot.docs) {
            const txData = txDoc.data();
            const transaction = {
                id: txDoc.id,
                partner: txData.partner || null,
                partnerId: txData.partnerId || null,
                name: txData.name || "",
                reference: txData.reference || null,
                noReceiptCategoryId: txData.noReceiptCategoryId || null,
                fileIds: txData.fileIds || [],
            };
            // Skip if has files attached
            if (!(0, category_matcher_1.isEligibleForCategoryMatching)(transaction)) {
                continue;
            }
            const matches = (0, category_matcher_1.matchTransactionToCategories)(transaction, categories, categoryManualRemovals);
            if (matches.length > 0) {
                const topMatch = matches[0];
                const updates = {
                    categorySuggestions: matches.map((m) => ({
                        categoryId: m.categoryId,
                        templateId: m.templateId,
                        confidence: m.confidence,
                        source: m.source,
                    })),
                    updatedAt: firestore_2.FieldValue.serverTimestamp(),
                };
                if ((0, category_matcher_1.shouldAutoApplyCategory)(topMatch.confidence)) {
                    updates.noReceiptCategoryId = topMatch.categoryId;
                    updates.noReceiptCategoryTemplateId = topMatch.templateId;
                    updates.noReceiptCategoryConfidence = topMatch.confidence;
                    updates.noReceiptCategoryMatchedBy = "auto";
                    autoMatched++;
                }
                else {
                    suggestionsAdded++;
                }
                batch.update(txDoc.ref, updates);
                batchCount++;
                if (batchCount >= BATCH_LIMIT) {
                    await batch.commit();
                    console.log(`Committed batch of ${batchCount} updates`);
                    batchCount = 0;
                }
            }
        }
        if (batchCount > 0) {
            await batch.commit();
        }
        console.log(`Category ${categoryData.name}: auto-matched ${autoMatched} transactions, added suggestions to ${suggestionsAdded}`);
    }
    catch (error) {
        console.error(`Error re-matching transactions for category ${categoryId}:`, error);
    }
});
//# sourceMappingURL=onCategoryCreate.js.map