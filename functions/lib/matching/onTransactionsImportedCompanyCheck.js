"use strict";
/**
 * Cloud Function: Company Declarative Checker
 *
 * Triggered when an import record is created.
 * 1. First runs partner matching against global and local partners
 * 2. Then checks remaining unmatched transactions for company legal suffixes (GmbH, Ltd, LLC)
 * 3. Queues agentic partner search for those with company names
 *
 * This catches transactions like "SEPA Lastschrift Amazon EU S.a.r.l." or
 * "Hetzner Online GmbH" that likely have findable company registrations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onTransactionsImportedCompanyCheck = exports.AUTOMATION_META = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firestore_2 = require("firebase-admin/firestore");
const partner_matcher_1 = require("../utils/partner-matcher");
const companyNameValidator_1 = require("../utils/companyNameValidator");
const createLocalPartnerFromGlobal_1 = require("./createLocalPartnerFromGlobal");
// =============================================================================
// AUTOMATION METADATA
// =============================================================================
exports.AUTOMATION_META = {
    id: "onTransactionsImportedCompanyCheck",
    name: "Partner Matching & Company Check",
    description: "On import: matches transactions to partners, then queues agentic search for unmatched transactions with company names (GmbH, Ltd, LLC)",
    trigger: {
        type: "document_create",
        collection: "imports",
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
                "automationHistory",
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
        maxCompanySearchPerImport: 10,
    },
    icon: "Building2",
    category: "matching",
    chains: ["matchCategories"],
};
// =============================================================================
// CONSTANTS
// =============================================================================
const CONFIG = {
    /** Maximum worker requests to queue per import (rate limiting) */
    MAX_COMPANY_SEARCH_PER_IMPORT: 10,
};
const db = (0, firestore_2.getFirestore)();
// =============================================================================
// HELPER FUNCTIONS
// =============================================================================
/**
 * Check if a transaction has already been processed by the company check automation.
 */
function hasCompanyCheckRun(automationHistory) {
    if (!automationHistory)
        return false;
    return automationHistory.some((entry) => entry.type === "company_check");
}
/**
 * Find a company name in transaction fields.
 * Checks partner > name > description in priority order.
 */
function findCompanyName(partner, name, description) {
    if (partner && (0, companyNameValidator_1.isValidCompanyName)(partner)) {
        return { value: partner, source: "partner" };
    }
    if (name && (0, companyNameValidator_1.isValidCompanyName)(name)) {
        return { value: name, source: "name" };
    }
    if (description && (0, companyNameValidator_1.isValidCompanyName)(description)) {
        return { value: description, source: "description" };
    }
    return null;
}
/**
 * Queue an agentic partner search for a transaction with a company name.
 */
async function queueCompanySearch(userId, transactionId, companyName, sourceField, legalSuffix) {
    const promptParts = [
        `Find partner for transaction ID: ${transactionId}`,
        `Company name detected: "${companyName}"`,
        `Source: transaction ${sourceField} field`,
    ];
    if (legalSuffix) {
        promptParts.push(`Legal suffix: ${legalSuffix}`);
    }
    promptParts.push(`This transaction has no partner assigned and wasn't matched by rule-based matching. ` +
        `Search company registries and create the partner.`);
    const initialPrompt = promptParts.join(". ");
    const requestRef = db.collection(`users/${userId}/workerRequests`).doc();
    await requestRef.set({
        id: requestRef.id,
        workerType: "partner_matching",
        initialPrompt,
        triggerContext: {
            transactionId,
            companyName,
            sourceField,
            triggeredByCompanyCheck: true,
        },
        triggeredBy: "auto",
        status: "pending",
        createdAt: firestore_2.Timestamp.now(),
    });
    return requestRef.id;
}
// =============================================================================
// FIRESTORE TRIGGER
// =============================================================================
exports.onTransactionsImportedCompanyCheck = (0, firestore_1.onDocumentCreated)({
    document: "imports/{importId}",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
}, async (event) => {
    const importId = event.params.importId;
    const importData = event.data?.data();
    if (!importData)
        return;
    // Skip if no transactions were imported
    if (!importData.importedCount || importData.importedCount === 0) {
        console.log(`[CompanyCheck] No transactions in import ${importId}, skipping`);
        return;
    }
    const userId = importData.userId;
    console.log(`[CompanyCheck] Processing import ${importId} for user ${userId} ` +
        `(${importData.importedCount} transactions)`);
    // =========================================================================
    // STEP 1: Partner Matching (reused from matchPartners callable)
    // =========================================================================
    // Fetch partners
    const [userPartnersSnapshot, globalPartnersSnapshot] = await Promise.all([
        db
            .collection("partners")
            .where("userId", "==", userId)
            .where("isActive", "==", true)
            .get(),
        db.collection("globalPartners").where("isActive", "==", true).get(),
    ]);
    // Build manual removals map
    const partnerManualRemovals = new Map();
    const userPartners = userPartnersSnapshot.docs.map((doc) => {
        const data = doc.data();
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
    // Filter out global partners that are already localized
    const localizedGlobalIds = new Set(userPartners
        .map((p) => p.globalPartnerId)
        .filter(Boolean));
    const filteredGlobalPartners = globalPartners.filter((p) => !localizedGlobalIds.has(p.id));
    // Build partner name map for automationHistory entries
    const partnerNameMap = new Map();
    for (const p of userPartners) {
        partnerNameMap.set(p.id, p.name);
    }
    for (const p of filteredGlobalPartners) {
        partnerNameMap.set(p.id, p.name);
    }
    // Fetch transactions from this import
    const transactionsSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("importJobId", "==", importId)
        .limit(1000)
        .get();
    if (transactionsSnapshot.empty) {
        console.log(`[CompanyCheck] No transactions found for import ${importId}`);
        return;
    }
    console.log(`[CompanyCheck] Found ${transactionsSnapshot.size} transactions to process`);
    // Run partner matching
    let autoMatched = 0;
    let withSuggestions = 0;
    let batch = db.batch();
    let batchCount = 0;
    for (const txDoc of transactionsSnapshot.docs) {
        const txData = txDoc.data();
        // Skip if already has a partner
        if (txData.partnerId) {
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
        if (matches.length > 0) {
            // Filter out matches where user explicitly removed this transaction
            const filteredMatches = matches.filter((m) => {
                const removals = partnerManualRemovals.get(m.partnerId);
                return !(removals && removals.has(txDoc.id));
            });
            if (filteredMatches.length === 0) {
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
                        console.error(`[CompanyCheck] Failed to create local partner from global:`, error);
                    }
                }
                updates.partnerId = assignedPartnerId;
                updates.partnerType = assignedPartnerType;
                updates.partnerMatchConfidence = topMatch.confidence;
                updates.partnerMatchedBy = "auto";
                autoMatched++;
                const partnerName = partnerNameMap.get(assignedPartnerId) || partnerNameMap.get(topMatch.partnerId) || null;
                updates.automationHistory = firestore_2.FieldValue.arrayUnion({
                    type: "partner_assigned",
                    ranAt: firestore_2.Timestamp.now(),
                    status: "completed",
                    actor: "auto",
                    level: "outcome",
                    forPartnerId: assignedPartnerId,
                    partnerName,
                    confidence: topMatch.confidence,
                    summary: `Partner "${partnerName || assignedPartnerId}" auto-assigned`,
                });
            }
            else {
                withSuggestions++;
            }
            batch.update(txDoc.ref, updates);
            batchCount++;
            if (batchCount >= 500) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
    }
    if (batchCount > 0) {
        await batch.commit();
    }
    console.log(`[CompanyCheck] Partner matching complete: ${autoMatched} auto-matched, ` +
        `${withSuggestions} with suggestions`);
    // =========================================================================
    // STEP 2: Company Declarative Check (for remaining unmatched)
    // =========================================================================
    // Re-query transactions that are still unmatched after partner matching
    const unmatchedSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("importJobId", "==", importId)
        .where("partnerId", "==", null)
        .limit(1000)
        .get();
    if (unmatchedSnapshot.empty) {
        console.log(`[CompanyCheck] All transactions matched, no company check needed`);
        return;
    }
    console.log(`[CompanyCheck] ${unmatchedSnapshot.size} transactions still unmatched, ` +
        `checking for company names`);
    // Find transactions with company names
    const candidates = [];
    for (const doc of unmatchedSnapshot.docs) {
        const data = doc.data();
        const automationHistory = data.automationHistory;
        // Skip if already processed by company check
        if (hasCompanyCheckRun(automationHistory)) {
            continue;
        }
        // Check for company name
        const companyMatch = findCompanyName(data.partner || null, data.name || "", data.description || null);
        if (companyMatch) {
            candidates.push({
                id: doc.id,
                ref: doc.ref,
                companyName: companyMatch.value,
                source: companyMatch.source,
                legalSuffix: (0, companyNameValidator_1.extractLegalSuffix)(companyMatch.value),
            });
        }
    }
    console.log(`[CompanyCheck] Found ${candidates.length} transactions with company names`);
    if (candidates.length === 0) {
        return;
    }
    // Limit to prevent flooding the worker queue
    const toProcess = candidates.slice(0, CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT);
    if (candidates.length > CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT) {
        console.log(`[CompanyCheck] Limiting to ${CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT} workers ` +
            `(${candidates.length} candidates)`);
    }
    // Queue worker requests and update automation history
    let queuedCount = 0;
    const now = firestore_2.Timestamp.now();
    const historyBatch = db.batch();
    for (const candidate of toProcess) {
        try {
            const workerRequestId = await queueCompanySearch(userId, candidate.id, candidate.companyName, candidate.source, candidate.legalSuffix);
            // Update transaction's automation history
            historyBatch.update(candidate.ref, {
                automationHistory: firestore_2.FieldValue.arrayUnion({
                    type: "company_check",
                    ranAt: now,
                    workerRequestId,
                    status: "queued",
                    summary: `Queued partner search for "${candidate.companyName}"`,
                }),
                updatedAt: firestore_2.FieldValue.serverTimestamp(),
            });
            queuedCount++;
        }
        catch (err) {
            console.error(`[CompanyCheck] Failed to queue search for transaction ${candidate.id}:`, err);
        }
    }
    // Mark remaining candidates as processed (not queued due to limit)
    if (candidates.length > CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT) {
        for (const candidate of candidates.slice(CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT)) {
            historyBatch.update(candidate.ref, {
                automationHistory: firestore_2.FieldValue.arrayUnion({
                    type: "company_check",
                    ranAt: now,
                    status: "skipped",
                    summary: `Skipped due to queue limit (company: "${candidate.companyName}")`,
                }),
                updatedAt: firestore_2.FieldValue.serverTimestamp(),
            });
        }
    }
    await historyBatch.commit();
    console.log(`[CompanyCheck] Completed for import ${importId}: ` +
        `${autoMatched} auto-matched, ${queuedCount} company searches queued`);
});
//# sourceMappingURL=onTransactionsImportedCompanyCheck.js.map