"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchPartners = exports.AUTOMATION_META = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const partner_matcher_1 = require("../utils/partner-matcher");
const matchCategories_1 = require("./matchCategories");
const createLocalPartnerFromGlobal_1 = require("./createLocalPartnerFromGlobal");
// =============================================================================
// AUTOMATION METADATA
// =============================================================================
exports.AUTOMATION_META = {
    id: "matchPartners",
    name: "Match Partners (Manual)",
    description: "Manually triggered partner matching for transactions. Matches by IBAN, name, and aliases; queues agentic search for uncertain matches.",
    trigger: {
        type: "callable",
        regions: ["europe-west1"],
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
        {
            entity: "workerRequest",
            fields: ["workerType", "initialPrompt", "triggerContext"],
            action: "create",
        },
    ],
    config: {
        autoMatchThreshold: 89,
        maxSuggestions: 3,
    },
    icon: "Search",
    category: "matching",
};
// =============================================================================
// IMPLEMENTATION
// =============================================================================
const db = (0, firestore_1.getFirestore)();
/**
 * Queue an agentic partner search worker when rule-based matching finds suggestions
 * but no confident auto-match. The agent can search for company info, check VAT registries,
 * and make smarter partner assignments.
 */
async function queueAgenticPartnerSearch(userId, transactionId, transactionData, topSuggestionConfidence) {
    const promptParts = [
        `Find partner for transaction ID: ${transactionId}`,
    ];
    // Add transaction name if available (not included in ID line to keep prompt clean)
    if (transactionData.name) {
        promptParts.push(`Transaction name: "${transactionData.name}"`);
    }
    if (topSuggestionConfidence > 0) {
        promptParts.push(`Rule-based matching found suggestions but no confident match (top: ${topSuggestionConfidence}%)`);
    }
    else {
        promptParts.push(`Rule-based matching found no suggestions - search broadly`);
    }
    if (transactionData.partner) {
        promptParts.push(`Bank partner field: ${transactionData.partner}`);
    }
    if (transactionData.partnerIban) {
        promptParts.push(`IBAN: ${transactionData.partnerIban}`);
    }
    if (transactionData.reference) {
        promptParts.push(`Reference: ${transactionData.reference}`);
    }
    const initialPrompt = promptParts.join(". ");
    // Create worker request for frontend/worker processor to pick up
    const requestRef = db.collection(`users/${userId}/workerRequests`).doc();
    await requestRef.set({
        id: requestRef.id,
        workerType: "partner_matching",
        initialPrompt,
        triggerContext: {
            transactionId,
            topSuggestionConfidence,
            triggeredAfterRuleBasedMatch: true,
        },
        triggeredBy: "auto",
        status: "pending",
        createdAt: firestore_1.Timestamp.now(),
    });
    console.log(`[PartnerMatch] Queued agentic search for transaction ${transactionId} (worker request ${requestRef.id}, ` +
        `top suggestion: ${topSuggestionConfidence}%)`);
}
function normalizeSuggestions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((item) => {
        if (!item || typeof item !== "object")
            return null;
        const candidate = item;
        if (typeof candidate.partnerId !== "string")
            return null;
        if (candidate.partnerType !== "global" && candidate.partnerType !== "user")
            return null;
        if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence))
            return null;
        if (typeof candidate.source !== "string")
            return null;
        return {
            partnerId: candidate.partnerId,
            partnerType: candidate.partnerType,
            confidence: candidate.confidence,
            source: candidate.source,
        };
    })
        .filter((item) => item !== null);
}
function suggestionsAreEqual(existing, next) {
    if (existing.length !== next.length)
        return false;
    for (let i = 0; i < existing.length; i++) {
        if (existing[i].partnerId !== next[i].partnerId)
            return false;
        if (existing[i].partnerType !== next[i].partnerType)
            return false;
        if (existing[i].confidence !== next[i].confidence)
            return false;
        if (existing[i].source !== next[i].source)
            return false;
    }
    return true;
}
/**
 * Callable function to manually trigger partner matching
 * Can match specific transactions or all unmatched ones
 */
exports.matchPartners = (0, https_1.onCall)({
    region: "europe-west1",
    memory: "512MiB",
}, async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { transactionIds, matchAll } = request.data;
    console.log(`Manual matching triggered by user ${userId}`, { transactionIds, matchAll });
    // Get partners
    const [userPartnersSnapshot, globalPartnersSnapshot] = await Promise.all([
        db
            .collection("partners")
            .where("userId", "==", userId)
            .where("isActive", "==", true)
            .get(),
        db.collection("globalPartners").where("isActive", "==", true).get(),
    ]);
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
            learnedPatterns: data.learnedPatterns || [],
            globalPartnerId: data.globalPartnerId || null,
        };
    });
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
    const localizedGlobalIds = new Set(userPartners
        .map((partner) => partner.globalPartnerId)
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
    // Get transactions to match
    let transactionsSnapshot;
    if (!matchAll && transactionIds && transactionIds.length > 0) {
        // Fetch specific transactions
        const docs = await Promise.all(transactionIds.map((id) => db.collection("transactions").doc(id).get()));
        transactionsSnapshot = docs.filter((doc) => doc.exists && doc.data()?.userId === userId);
    }
    else if (!matchAll) {
        // Only unmatched transactions
        const query = await db
            .collection("transactions")
            .where("userId", "==", userId)
            .where("partnerId", "==", null)
            .limit(1000)
            .get();
        transactionsSnapshot = query.docs;
    }
    else {
        // All transactions (force re-match)
        const query = await db
            .collection("transactions")
            .where("userId", "==", userId)
            .limit(1000)
            .get();
        transactionsSnapshot = query.docs;
    }
    const transactions = Array.isArray(transactionsSnapshot)
        ? transactionsSnapshot
        : transactionsSnapshot;
    let processed = 0;
    let autoMatched = 0;
    let withSuggestions = 0;
    const processedTransactionIds = [];
    const autoMatchedPartnerIds = new Set(); // Track partners for file matching
    // Track transactions for agentic fallback: { transactionId, transactionData, topConfidence }
    const noAutoMatchTransactions = [];
    let batch = db.batch();
    let batchCount = 0;
    for (const txDoc of transactions) {
        if (!txDoc.exists)
            continue;
        const txData = txDoc.data();
        const existingPartnerId = txData.partnerId;
        if (existingPartnerId) {
            // Avoid overriding any existing assignment (manual/suggestion/auto/legacy).
            continue;
        }
        // Skip transactions with no-receipt categories (already complete, don't need partner)
        if (txData.noReceiptCategoryId) {
            continue;
        }
        // Skip over-quota transactions (imported but processing limited)
        if (txData.quotaExceeded) {
            continue;
        }
        const transaction = {
            id: txDoc.id,
            partner: txData.partner || null,
            partnerIban: txData.partnerIban || null,
            name: txData.name || "",
            reference: txData.reference || null,
        };
        const matches = (0, partner_matcher_1.matchTransaction)(transaction, userPartners, filteredGlobalPartners);
        processed++;
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
            const nextSuggestions = filteredMatches.map((m) => ({
                partnerId: m.partnerId,
                partnerType: m.partnerType,
                confidence: m.confidence,
                source: m.source,
            }));
            const existingSuggestions = normalizeSuggestions(txData.partnerSuggestions);
            const suggestionsChanged = !suggestionsAreEqual(existingSuggestions, nextSuggestions);
            const updates = {
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            };
            if ((0, partner_matcher_1.shouldAutoApply)(topMatch.confidence)) {
                updates.partnerSuggestions = nextSuggestions;
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
                const partnerName = partnerNameMap.get(assignedPartnerId) || partnerNameMap.get(topMatch.partnerId) || null;
                updates.automationHistory = firestore_1.FieldValue.arrayUnion({
                    type: "partner_assigned",
                    ranAt: firestore_1.Timestamp.now(),
                    status: "completed",
                    actor: "auto",
                    level: "outcome",
                    forPartnerId: assignedPartnerId,
                    partnerName,
                    confidence: topMatch.confidence,
                    summary: `Partner "${partnerName || assignedPartnerId}" auto-assigned`,
                });
                // Track partner for file matching (only user partners can have files)
                if (assignedPartnerType === "user") {
                    autoMatchedPartnerIds.add(assignedPartnerId);
                }
            }
            else {
                if (!suggestionsChanged) {
                    // Already has the same suggestions: no-op for this run.
                    continue;
                }
                updates.partnerSuggestions = nextSuggestions;
                withSuggestions++;
                // Track for potential agentic fallback - has suggestions but not confident enough
                noAutoMatchTransactions.push({
                    id: txDoc.id,
                    data: transaction,
                    topConfidence: topMatch.confidence,
                });
            }
            batch.update(txDoc.ref, updates);
            processedTransactionIds.push(txDoc.id);
            batchCount++;
            if (batchCount >= 500) {
                await batch.commit();
                batch = db.batch(); // Create new batch after commit
                batchCount = 0;
            }
        }
    }
    if (batchCount > 0) {
        await batch.commit();
    }
    console.log(`Matching complete: ${processed} processed, ${autoMatched} auto-matched, ${withSuggestions} new/updated suggestions`);
    // Create notification if there were results
    if (autoMatched > 0 || withSuggestions > 0) {
        try {
            await db.collection(`users/${userId}/notifications`).add({
                type: "partner_matching",
                title: autoMatched > 0
                    ? `Matched ${autoMatched} transaction${autoMatched !== 1 ? "s" : ""} automatically`
                    : `Found new suggestions for ${withSuggestions} transaction${withSuggestions !== 1 ? "s" : ""}`,
                message: autoMatched > 0
                    ? `I analyzed your transactions and automatically matched ${autoMatched} to known partners.${withSuggestions > 0 ? ` ${withSuggestions} more need your review.` : ""}`
                    : `I found new partner suggestions for ${withSuggestions} transaction${withSuggestions !== 1 ? "s" : ""}. Please review and confirm.`,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
                readAt: null,
                context: {
                    autoMatchedCount: autoMatched,
                    suggestionsCount: withSuggestions,
                },
            });
        }
        catch (err) {
            console.error("Failed to create partner matching notification:", err);
        }
    }
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
    // Chain file matching for auto-matched partners
    // This finds receipts/files for transactions that just got partner-matched
    if (autoMatchedPartnerIds.size > 0) {
        console.log(`Chaining file matching for ${autoMatchedPartnerIds.size} partners`);
        try {
            const { matchFilesForPartnerInternal } = await Promise.resolve().then(() => __importStar(require("./matchFilesForPartner")));
            for (const partnerId of autoMatchedPartnerIds) {
                try {
                    const fileResult = await matchFilesForPartnerInternal(userId, partnerId);
                    if (fileResult.autoMatched > 0 || fileResult.suggested > 0) {
                        console.log(`File matching for partner ${partnerId}: ${fileResult.autoMatched} auto-matched, ${fileResult.suggested} suggested`);
                    }
                }
                catch (err) {
                    console.error(`Failed to chain file matching for partner ${partnerId}:`, err);
                }
            }
        }
        catch (err) {
            console.error("Failed to import matchFilesForPartnerInternal:", err);
        }
    }
    // Queue agentic partner search for transactions with suggestions but no auto-match
    // Limit to 5 transactions to avoid flooding the worker queue
    if (noAutoMatchTransactions.length > 0 && noAutoMatchTransactions.length <= 5) {
        console.log(`Queueing agentic partner search for ${noAutoMatchTransactions.length} transactions without confident match`);
        for (const { id: txId, data: txData, topConfidence } of noAutoMatchTransactions) {
            try {
                await queueAgenticPartnerSearch(userId, txId, txData, topConfidence);
            }
            catch (err) {
                console.error(`Failed to queue agentic search for transaction ${txId}:`, err);
            }
        }
    }
    else if (noAutoMatchTransactions.length > 5) {
        console.log(`[PartnerMatch] ${noAutoMatchTransactions.length} transactions without confident match - ` +
            `skipping agentic fallback (batch too large, user should review manually)`);
    }
    return {
        processed,
        autoMatched,
        withSuggestions,
    };
});
//# sourceMappingURL=matchPartners.js.map