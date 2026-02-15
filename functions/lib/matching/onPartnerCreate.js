"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onPartnerCreate = exports.AUTOMATION_META = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const partner_matcher_1 = require("../utils/partner-matcher");
const matchCategories_1 = require("./matchCategories");
const createLocalPartnerFromGlobal_1 = require("./createLocalPartnerFromGlobal");
// =============================================================================
// AUTOMATION METADATA
// =============================================================================
exports.AUTOMATION_META = {
    id: "onPartnerCreate",
    name: "Re-match on Partner Create",
    description: "Re-evaluates unmatched transactions when a new partner is created to find matches",
    trigger: {
        type: "document_create",
        collection: "partners",
    },
    effects: [
        {
            entity: "transaction",
            fields: [
                "partnerId",
                "partnerType",
                "partnerMatchedBy",
                "partnerMatchConfidence",
                "partnerSuggestions",
            ],
            action: "update",
        },
    ],
    config: {
        autoApplyThreshold: 89,
        maxTransactionsPerRun: 500,
    },
    chains: ["onTransactionUpdate"],
    icon: "Building2",
    category: "matching",
};
// =============================================================================
// IMPLEMENTATION
// =============================================================================
const db = (0, firestore_2.getFirestore)();
/**
 * Triggered when a new user partner is created
 * Re-matches unmatched transactions for that user
 */
exports.onPartnerCreate = (0, firestore_1.onDocumentCreated)({
    document: "partners/{partnerId}",
    region: "europe-west1",
}, async (event) => {
    const snapshot = event.data;
    if (!snapshot)
        return;
    const partnerData = snapshot.data();
    const partnerId = snapshot.id;
    const userId = partnerData.userId;
    console.log(`New partner created: ${partnerData.name} (${partnerId}) for user ${userId}`);
    if (partnerData.globalPartnerId && partnerData.createdBy === "auto_partner_match") {
        console.log(`Skipping re-match for localized partner ${partnerId} (global ${partnerData.globalPartnerId})`);
        return;
    }
    // Skip for partners created for manual assignment
    // (the calling code will assign the partner manually after creation)
    if (partnerData.createdBy === "manual_assignment") {
        console.log(`Skipping re-match for manually created partner ${partnerId} - will be assigned manually`);
        return;
    }
    try {
        // Get unmatched transactions for this user (no partnerId set)
        const unmatchedSnapshot = await db
            .collection("transactions")
            .where("userId", "==", userId)
            .where("partnerId", "==", null)
            .limit(500)
            .get();
        if (unmatchedSnapshot.empty) {
            console.log(`No unmatched transactions found for user ${userId}`);
            return;
        }
        console.log(`Found ${unmatchedSnapshot.size} unmatched transactions`);
        // Get all partners for matching
        const userPartnersSnapshot = await db
            .collection("partners")
            .where("userId", "==", userId)
            .where("isActive", "==", true)
            .get();
        // Build map of partnerId -> Set<transactionIds> for manual removals
        const partnerManualRemovals = new Map();
        const userPartners = userPartnersSnapshot.docs.map((doc) => {
            const data = doc.data();
            // Track manual removals for this partner
            const removals = data.manualRemovals || [];
            if (removals.length > 0) {
                partnerManualRemovals.set(doc.id, new Set(removals.map((r) => r.transactionId)));
            }
            return {
                id: doc.id,
                name: data.name,
                aliases: data.aliases || [],
                ibans: data.ibans || [],
                website: data.website,
                vatId: data.vatId,
            };
        });
        const globalPartnersSnapshot = await db
            .collection("globalPartners")
            .where("isActive", "==", true)
            .get();
        const globalPartners = globalPartnersSnapshot.docs.map((doc) => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name,
                aliases: data.aliases || [],
                ibans: data.ibans || [],
                website: data.website,
                vatId: data.vatId,
                patterns: data.patterns || [],
            };
        });
        const localizedGlobalIds = new Set(userPartnersSnapshot.docs
            .map((doc) => doc.data().globalPartnerId)
            .filter(Boolean));
        const filteredGlobalPartners = globalPartners.filter((partner) => !localizedGlobalIds.has(partner.id));
        // Build partner name map for automationHistory entries
        const partnerNameMap = new Map();
        for (const p of userPartners) {
            partnerNameMap.set(p.id, p.name);
        }
        for (const p of filteredGlobalPartners) {
            partnerNameMap.set(p.id, p.name);
        }
        // Process each unmatched transaction
        const batch = db.batch();
        let batchCount = 0;
        let autoMatched = 0;
        let suggestionsAdded = 0;
        const BATCH_LIMIT = 500;
        const processedTransactionIds = [];
        for (const txDoc of unmatchedSnapshot.docs) {
            const txData = txDoc.data();
            const transaction = {
                id: txDoc.id,
                partner: txData.partner || null,
                partnerIban: txData.partnerIban || null,
                name: txData.name || "",
                reference: txData.reference || null,
            };
            const matches = (0, partner_matcher_1.matchTransaction)(transaction, userPartners, filteredGlobalPartners);
            processedTransactionIds.push(txDoc.id);
            if (matches.length > 0) {
                // Filter out matches where user explicitly removed this transaction from the partner
                const filteredMatches = matches.filter((m) => {
                    const removals = partnerManualRemovals.get(m.partnerId);
                    if (removals && removals.has(txDoc.id)) {
                        console.log(`  -> Skipping partner ${m.partnerId} - tx ${txDoc.id} was manually removed`);
                        return false;
                    }
                    return true;
                });
                if (filteredMatches.length === 0) {
                    // All matches were filtered out due to manual removals
                    continue;
                }
                const topMatch = filteredMatches[0];
                const updates = {
                    partnerSuggestions: filteredMatches.map((m) => ({
                        partnerId: m.partnerId,
                        partnerType: m.partnerType,
                        confidence: m.confidence,
                        source: m.source,
                    })),
                    updatedAt: firestore_2.FieldValue.serverTimestamp(),
                };
                if ((0, partner_matcher_1.shouldAutoApply)(topMatch.confidence)) {
                    let assignedPartnerId = topMatch.partnerId;
                    let assignedPartnerType = topMatch.partnerType;
                    if (topMatch.partnerType === "global") {
                        try {
                            assignedPartnerId = await (0, createLocalPartnerFromGlobal_1.createLocalPartnerFromGlobal)(userId, topMatch.partnerId);
                            assignedPartnerType = "user";
                        }
                        catch (error) {
                            console.error(`[PartnerMatch] Failed to create local partner from global:`, error);
                            // Fall back to assigning global if localization fails
                        }
                    }
                    updates.partnerId = assignedPartnerId;
                    updates.partnerType = assignedPartnerType;
                    updates.partnerMatchConfidence = topMatch.confidence;
                    updates.partnerMatchedBy = "auto";
                    autoMatched++;
                    const assignedPartnerName = partnerNameMap.get(assignedPartnerId) || partnerNameMap.get(topMatch.partnerId) || null;
                    updates.automationHistory = firestore_2.FieldValue.arrayUnion({
                        type: "partner_assigned",
                        ranAt: firestore_2.Timestamp.now(),
                        status: "completed",
                        actor: "auto",
                        level: "outcome",
                        forPartnerId: assignedPartnerId,
                        partnerName: assignedPartnerName,
                        confidence: topMatch.confidence,
                        summary: `Partner "${assignedPartnerName || assignedPartnerId}" auto-assigned`,
                    });
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
        console.log(`Partner ${partnerData.name}: auto-matched ${autoMatched} transactions, added suggestions to ${suggestionsAdded}`);
        // Chain category matching after partner matching completes
        // Categories can use partnerId for 85% confidence matching
        if (processedTransactionIds.length > 0) {
            try {
                const categoryResult = await (0, matchCategories_1.matchCategoriesForTransactions)(userId, processedTransactionIds);
                console.log(`Category matching chained: ${categoryResult.autoMatched} auto-matched, ${categoryResult.withSuggestions} with suggestions`);
            }
            catch (err) {
                console.error("Failed to chain category matching:", err);
            }
        }
    }
    catch (error) {
        console.error(`Error re-matching transactions for partner ${partnerId}:`, error);
    }
});
//# sourceMappingURL=onPartnerCreate.js.map