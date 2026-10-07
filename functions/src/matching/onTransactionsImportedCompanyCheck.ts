/**
 * Cloud Function: Company Declarative Checker
 *
 * Triggered when an import is completed: an import record created as
 * completed, or a draft import record completed by an update (the app imports
 * through a draft, whose record is created with no lines).
 * 1. First runs partner matching against global and local partners
 * 2. Then checks remaining unmatched transactions for company legal suffixes (GmbH, Ltd, LLC)
 * 3. Queues agentic partner search for those with company names
 *
 * This catches transactions like "SEPA Lastschrift Amazon EU S.a.r.l." or
 * "Hetzner Online GmbH" that likely have findable company registrations.
 */

import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { isValidCompanyName, extractLegalSuffix } from "../utils/companyNameValidator";
import { AutomationMeta } from "../automation/types";
import {
  applyPartnerMatchUpdates,
  loadPartnerMatchingContext,
  processPartnerMatchesForTransactions,
  queuePartnerMatchingWorker,
} from "./partnerMatchingShared";

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

  return queuePartnerMatchingWorker(userId, initialPrompt, {
    transactionId,
    companyName,
    sourceField,
    triggeredByCompanyCheck: true,
  });
}

// =============================================================================
// IMPORT HANDLER
// =============================================================================

/** The triggers' body, exported so the self-host suite can drive it. */
export async function handleImportCompanyCheck(
  importId: string,
  importData: ImportRecord
): Promise<void> {
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

  const partnerContext = await loadPartnerMatchingContext(userId);

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

  const matchResult = await processPartnerMatchesForTransactions({
    userId,
    transactions: transactionsSnapshot.docs,
    partnerContext,
    skipUnchangedSuggestions: false,
    collectAgenticFallback: false,
  });

  // #139: assignments just changed which pairs score partner points, so the
  // affected Partners' unconnected Files get their suggestions re-scored.
  await applyPartnerMatchUpdates(matchResult.writeOperations, { userId });

  const { autoMatched, withSuggestions } = matchResult;

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

// =============================================================================
// FIRESTORE TRIGGERS
// =============================================================================

const TRIGGER_OPTIONS = {
  document: "imports/{importId}",
  region: "europe-west1",
  memory: "512MiB" as const,
  timeoutSeconds: 300,
};

/** An import record created already completed (no draft before it). */
export const onTransactionsImportedCompanyCheck = onDocumentCreated(
  TRIGGER_OPTIONS,
  async (event) => {
    const importData = event.data?.data() as ImportRecord | undefined;
    if (!importData) return;
    await handleImportCompanyCheck(event.params.importId, importData);
  }
);

/**
 * The app imports through a draft: the import record is created with no lines
 * and completed by an update once they are written, so the create trigger above
 * sees an empty import and skips. This one runs the check when a draft is
 * completed.
 */
export const onDraftImportCompletedCompanyCheck = onDocumentUpdated(
  TRIGGER_OPTIONS,
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data() as ImportRecord | undefined;
    if (!after || before?.status !== "draft" || after.status !== "completed") return;
    await handleImportCompanyCheck(event.params.importId, after);
  }
);
