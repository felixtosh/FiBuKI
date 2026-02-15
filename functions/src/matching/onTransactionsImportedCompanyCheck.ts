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

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  matchTransaction,
  shouldAutoApply,
  PartnerData,
  TransactionData,
} from "../utils/partner-matcher";
import { isValidCompanyName, extractLegalSuffix } from "../utils/companyNameValidator";
import { createLocalPartnerFromGlobal } from "./createLocalPartnerFromGlobal";
import { AutomationMeta } from "../automation/types";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "onTransactionsImportedCompanyCheck",
  name: "Partner Matching & Company Check",
  description:
    "On import: matches transactions to partners, then queues agentic search for unmatched transactions with company names (GmbH, Ltd, LLC)",
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

const db = getFirestore();

// =============================================================================
// TYPES
// =============================================================================

interface ImportRecord {
  userId: string;
  sourceId: string;
  importedCount: number;
  status?: string;
}

interface AutomationHistoryEntry {
  type: string;
  ranAt: Timestamp;
  status: string;
  summary?: string;
  workerRequestId?: string;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a transaction has already been processed by the company check automation.
 */
function hasCompanyCheckRun(
  automationHistory: AutomationHistoryEntry[] | undefined
): boolean {
  if (!automationHistory) return false;
  return automationHistory.some((entry) => entry.type === "company_check");
}

/**
 * Find a company name in transaction fields.
 * Checks partner > name > description in priority order.
 */
function findCompanyName(
  partner: string | null,
  name: string,
  description: string | null
): { value: string; source: "partner" | "name" | "description" } | null {
  if (partner && isValidCompanyName(partner)) {
    return { value: partner, source: "partner" };
  }
  if (name && isValidCompanyName(name)) {
    return { value: name, source: "name" };
  }
  if (description && isValidCompanyName(description)) {
    return { value: description, source: "description" };
  }
  return null;
}

/**
 * Queue an agentic partner search for a transaction with a company name.
 */
async function queueCompanySearch(
  userId: string,
  transactionId: string,
  companyName: string,
  sourceField: string,
  legalSuffix: string | null
): Promise<string> {
  const promptParts = [
    `Find partner for transaction ID: ${transactionId}`,
    `Company name detected: "${companyName}"`,
    `Source: transaction ${sourceField} field`,
  ];

  if (legalSuffix) {
    promptParts.push(`Legal suffix: ${legalSuffix}`);
  }

  promptParts.push(
    `This transaction has no partner assigned and wasn't matched by rule-based matching. ` +
    `Search company registries and create the partner.`
  );

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
    createdAt: Timestamp.now(),
  });

  return requestRef.id;
}

// =============================================================================
// FIRESTORE TRIGGER
// =============================================================================

export const onTransactionsImportedCompanyCheck = onDocumentCreated(
  {
    document: "imports/{importId}",
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    const importId = event.params.importId;
    const importData = event.data?.data() as ImportRecord | undefined;

    if (!importData) return;

    // Skip if no transactions were imported
    if (!importData.importedCount || importData.importedCount === 0) {
      console.log(`[CompanyCheck] No transactions in import ${importId}, skipping`);
      return;
    }

    const userId = importData.userId;
    console.log(
      `[CompanyCheck] Processing import ${importId} for user ${userId} ` +
      `(${importData.importedCount} transactions)`
    );

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
    const partnerManualRemovals = new Map<string, Set<string>>();

    const userPartners: PartnerData[] = userPartnersSnapshot.docs.map((doc) => {
      const data = doc.data();

      const removals = data.manualRemovals || [];
      if (removals.length > 0) {
        partnerManualRemovals.set(
          doc.id,
          new Set(removals.map((r: { transactionId: string }) => r.transactionId))
        );
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

    const globalPartners: PartnerData[] = globalPartnersSnapshot.docs.map((doc) => {
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
    const localizedGlobalIds = new Set(
      userPartners
        .map((p) => p.globalPartnerId)
        .filter(Boolean) as string[]
    );
    const filteredGlobalPartners = globalPartners.filter(
      (p) => !localizedGlobalIds.has(p.id)
    );

    // Build partner name map for automationHistory entries
    const partnerNameMap = new Map<string, string>();
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

      const transaction: TransactionData = {
        id: txDoc.id,
        partner: txData.partner || null,
        partnerIban: txData.partnerIban || null,
        name: txData.name || "",
        reference: txData.reference || null,
      };

      const matches = matchTransaction(transaction, userPartners, filteredGlobalPartners);

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
        const updates: Record<string, unknown> = {
          partnerSuggestions: filteredMatches.map((m) => ({
            partnerId: m.partnerId,
            partnerType: m.partnerType,
            confidence: m.confidence,
            source: m.source,
          })),
          updatedAt: FieldValue.serverTimestamp(),
        };

        if (shouldAutoApply(topMatch.confidence)) {
          let assignedPartnerId = topMatch.partnerId;
          let assignedPartnerType = topMatch.partnerType;

          if (topMatch.partnerType === "global") {
            try {
              assignedPartnerId = await createLocalPartnerFromGlobal(userId, topMatch.partnerId);
              assignedPartnerType = "user";
            } catch (error) {
              console.error(
                `[CompanyCheck] Failed to create local partner from global:`,
                error
              );
            }
          }

          updates.partnerId = assignedPartnerId;
          updates.partnerType = assignedPartnerType;
          updates.partnerMatchConfidence = topMatch.confidence;
          updates.partnerMatchedBy = "auto";
          autoMatched++;

          const partnerName = partnerNameMap.get(assignedPartnerId) || partnerNameMap.get(topMatch.partnerId) || null;
          updates.automationHistory = FieldValue.arrayUnion({
            type: "partner_assigned",
            ranAt: Timestamp.now(),
            status: "completed",
            actor: "auto",
            level: "outcome",
            forPartnerId: assignedPartnerId,
            partnerName,
            confidence: topMatch.confidence,
            summary: `Partner "${partnerName || assignedPartnerId}" auto-assigned`,
          });
        } else {
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

    console.log(
      `[CompanyCheck] Partner matching complete: ${autoMatched} auto-matched, ` +
      `${withSuggestions} with suggestions`
    );

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

    console.log(
      `[CompanyCheck] ${unmatchedSnapshot.size} transactions still unmatched, ` +
      `checking for company names`
    );

    // Find transactions with company names
    const candidates: Array<{
      id: string;
      ref: FirebaseFirestore.DocumentReference;
      companyName: string;
      source: "partner" | "name" | "description";
      legalSuffix: string | null;
    }> = [];

    for (const doc of unmatchedSnapshot.docs) {
      const data = doc.data();
      const automationHistory = data.automationHistory as AutomationHistoryEntry[] | undefined;

      // Skip if already processed by company check
      if (hasCompanyCheckRun(automationHistory)) {
        continue;
      }

      // Check for company name
      const companyMatch = findCompanyName(
        data.partner || null,
        data.name || "",
        data.description || null
      );

      if (companyMatch) {
        candidates.push({
          id: doc.id,
          ref: doc.ref,
          companyName: companyMatch.value,
          source: companyMatch.source,
          legalSuffix: extractLegalSuffix(companyMatch.value),
        });
      }
    }

    console.log(
      `[CompanyCheck] Found ${candidates.length} transactions with company names`
    );

    if (candidates.length === 0) {
      return;
    }

    // Limit to prevent flooding the worker queue
    const toProcess = candidates.slice(0, CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT);
    if (candidates.length > CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT) {
      console.log(
        `[CompanyCheck] Limiting to ${CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT} workers ` +
        `(${candidates.length} candidates)`
      );
    }

    // Queue worker requests and update automation history
    let queuedCount = 0;
    const now = Timestamp.now();
    const historyBatch = db.batch();

    for (const candidate of toProcess) {
      try {
        const workerRequestId = await queueCompanySearch(
          userId,
          candidate.id,
          candidate.companyName,
          candidate.source,
          candidate.legalSuffix
        );

        // Update transaction's automation history
        historyBatch.update(candidate.ref, {
          automationHistory: FieldValue.arrayUnion({
            type: "company_check",
            ranAt: now,
            workerRequestId,
            status: "queued",
            summary: `Queued partner search for "${candidate.companyName}"`,
          }),
          updatedAt: FieldValue.serverTimestamp(),
        });

        queuedCount++;
      } catch (err) {
        console.error(
          `[CompanyCheck] Failed to queue search for transaction ${candidate.id}:`,
          err
        );
      }
    }

    // Mark remaining candidates as processed (not queued due to limit)
    if (candidates.length > CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT) {
      for (const candidate of candidates.slice(CONFIG.MAX_COMPANY_SEARCH_PER_IMPORT)) {
        historyBatch.update(candidate.ref, {
          automationHistory: FieldValue.arrayUnion({
            type: "company_check",
            ranAt: now,
            status: "skipped",
            summary: `Skipped due to queue limit (company: "${candidate.companyName}")`,
          }),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    await historyBatch.commit();

    console.log(
      `[CompanyCheck] Completed for import ${importId}: ` +
      `${autoMatched} auto-matched, ${queuedCount} company searches queued`
    );
  }
);
