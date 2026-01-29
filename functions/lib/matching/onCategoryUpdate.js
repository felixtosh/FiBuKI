"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onCategoryUpdate = exports.AUTOMATION_META = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const category_matcher_1 = require("../utils/category-matcher");
// =============================================================================
// AUTOMATION METADATA
// =============================================================================
exports.AUTOMATION_META = {
    id: "onCategoryUpdate",
    name: "Re-match on Category Update",
    description: "Re-evaluates unmatched transactions when category patterns or matched partners change",
    trigger: {
        type: "document_update",
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
 * Triggered when a no-receipt category is updated.
 * Re-matches unmatched transactions when patterns or partners are modified.
 */
exports.onCategoryUpdate = (0, firestore_1.onDocumentUpdated)({
    document: "noReceiptCategories/{categoryId}",
    region: "europe-west1",
}, async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const categoryId = event.params.categoryId;
    if (!before || !after)
        return;
    // Check if matchedPartnerIds or learnedPatterns changed
    const partnersChanged = JSON.stringify(before.matchedPartnerIds || []) !==
        JSON.stringify(after.matchedPartnerIds || []);
    const patternsChanged = JSON.stringify(before.learnedPatterns || []) !==
        JSON.stringify(after.learnedPatterns || []);
    if (!partnersChanged && !patternsChanged) {
        return;
    }
    const userId = after.userId;
    console.log(`Category ${after.name} (${categoryId}) updated: partners=${partnersChanged}, patterns=${patternsChanged}`);
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
        console.log(`Found ${unmatchedSnapshot.size} unmatched transactions to re-match`);
        // Get all active categories for matching
        const categoriesSnapshot = await db
            .collection("noReceiptCategories")
            .where("userId", "==", userId)
            .where("isActive", "==", true)
            .get();
        // Build map of categoryId -> Set<transactionIds> for manual removals
        const categoryManualRemovals = new Map();
        const categories = categoriesSnapshot.docs.map((doc) => {
            const data = doc.data();
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
        let batch = db.batch();
        let batchCount = 0;
        let autoMatched = 0;
        let suggestionsUpdated = 0;
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
                    updates.isComplete = true;
                    // Link partner to category if applicable
                    if (transaction.partnerId) {
                        const category = categories.find((c) => c.id === topMatch.categoryId);
                        if (category && !category.matchedPartnerIds.includes(transaction.partnerId)) {
                            batch.update(db.collection("noReceiptCategories").doc(topMatch.categoryId), {
                                matchedPartnerIds: firestore_2.FieldValue.arrayUnion(transaction.partnerId),
                                updatedAt: firestore_2.FieldValue.serverTimestamp(),
                            });
                            category.matchedPartnerIds.push(transaction.partnerId);
                            batchCount++;
                        }
                    }
                    autoMatched++;
                }
                else {
                    suggestionsUpdated++;
                }
                batch.update(txDoc.ref, updates);
                batchCount++;
                if (batchCount >= BATCH_LIMIT) {
                    await batch.commit();
                    console.log(`Committed batch of ${batchCount} updates`);
                    batch = db.batch();
                    batchCount = 0;
                }
            }
        }
        if (batchCount > 0) {
            await batch.commit();
        }
        console.log(`Category ${after.name} update: auto-matched ${autoMatched} transactions, updated suggestions for ${suggestionsUpdated}`);
    }
    catch (error) {
        console.error(`Error re-matching transactions for category ${categoryId}:`, error);
    }
});
//# sourceMappingURL=onCategoryUpdate.js.map