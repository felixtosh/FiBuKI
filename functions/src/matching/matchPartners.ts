import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { matchCategoriesForTransactions } from "./matchCategories";
import { AutomationMeta } from "../automation/types";
import {
  applyPartnerMatchUpdates,
  loadPartnerMatchingContext,
  NoAutoMatchTransaction,
  processPartnerMatchesForTransactions,
  queuePartnerMatchingWorker,
} from "./partnerMatchingShared";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "matchPartners",
  name: "Match Partners (Manual)",
  description:
    "Manually triggered partner matching for transactions. Matches by IBAN, name, and aliases; queues agentic search for uncertain matches.",
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

const db = getFirestore();

/**
 * Queue an agentic partner search worker when rule-based matching finds suggestions
 * but no confident auto-match. The agent can search for company info, check VAT registries,
 * and make smarter partner assignments.
 */
async function queueAgenticPartnerSearch(
  userId: string,
  transactionId: string,
  transactionData: NoAutoMatchTransaction["data"],
  topSuggestionConfidence: number
): Promise<void> {
  const promptParts = [
    `Find partner for transaction ID: ${transactionId}`,
  ];

  // Add transaction name if available (not included in ID line to keep prompt clean)
  if (transactionData.name) {
    promptParts.push(`Transaction name: "${transactionData.name}"`);
  }

  if (topSuggestionConfidence > 0) {
    promptParts.push(`Rule-based matching found suggestions but no confident match (top: ${topSuggestionConfidence}%)`);
  } else {
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

  const requestId = await queuePartnerMatchingWorker(userId, initialPrompt, {
    transactionId,
    topSuggestionConfidence,
    triggeredAfterRuleBasedMatch: true,
  });

  console.log(
    `[PartnerMatch] Queued agentic search for transaction ${transactionId} (worker request ${requestId}, ` +
    `top suggestion: ${topSuggestionConfidence}%)`
  );
}

interface MatchPartnersRequest {
  transactionIds?: string[];
  matchAll?: boolean;
}

export interface MatchPartnersResponse {
  processed: number;
  autoMatched: number;
  withSuggestions: number;
}

export interface PartnerMatchingRun {
  transactionIds?: string[];
  matchAll?: boolean;
  /**
   * Queue the agentic partner search for the few transactions rule-based
   * matching could not settle. On for a user asking (matchPartners), off for
   * the background catch-up after a directory change.
   */
  agenticFallback: boolean;
}

/**
 * Rule-based partner matching for one user: specific transactions, the
 * unassigned ones, or all. Writes suggestions and auto-assignments, then
 * chains category and file matching. The one implementation behind the
 * matchPartners callable and catchUpPartnerMatching.
 */
export async function runPartnerMatching(
  userId: string,
  { transactionIds, matchAll, agenticFallback }: PartnerMatchingRun
): Promise<MatchPartnersResponse> {
  console.log(`Partner matching for user ${userId}`, { transactionIds, matchAll, agenticFallback });

  const partnerContext = await loadPartnerMatchingContext(userId);

  // Get transactions to match
  let transactionsSnapshot;

  if (!matchAll && transactionIds && transactionIds.length > 0) {
    // Fetch specific transactions
    const docs = await Promise.all(
      transactionIds.map((id) => db.collection("transactions").doc(id).get())
    );
    transactionsSnapshot = docs.filter(
      (doc) => doc.exists && doc.data()?.userId === userId
    );
  } else if (!matchAll) {
    // Only unmatched transactions
    const query = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("partnerId", "==", null)
      .limit(1000)
      .get();
    transactionsSnapshot = query.docs;
  } else {
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

  const matchResult = await processPartnerMatchesForTransactions({
    userId,
    transactions,
    partnerContext,
    skipUnchangedSuggestions: true,
    collectAgenticFallback: true,
  });

  // #139: assignments just changed which pairs score partner points, so the
  // affected Partners' unconnected Files get their suggestions re-scored.
  await applyPartnerMatchUpdates(matchResult.writeOperations, { userId });

  const {
    processed,
    autoMatched,
    withSuggestions,
    processedTransactionIds,
    autoMatchedPartnerIds,
    noAutoMatchTransactions,
  } = matchResult;

  console.log(`Matching complete: ${processed} processed, ${autoMatched} auto-matched, ${withSuggestions} new/updated suggestions`);

  // Create notification if there were results
  if (autoMatched > 0 || withSuggestions > 0) {
    try {
      await db.collection(`users/${userId}/notifications`).add({
        type: "partner_matching",
        title:
          autoMatched > 0
            ? `Matched ${autoMatched} transaction${autoMatched !== 1 ? "s" : ""} automatically`
            : `Found new suggestions for ${withSuggestions} transaction${withSuggestions !== 1 ? "s" : ""}`,
        message:
          autoMatched > 0
            ? `I analyzed your transactions and automatically matched ${autoMatched} to known partners.${withSuggestions > 0 ? ` ${withSuggestions} more need your review.` : ""}`
            : `I found new partner suggestions for ${withSuggestions} transaction${withSuggestions !== 1 ? "s" : ""}. Please review and confirm.`,
        createdAt: FieldValue.serverTimestamp(),
        readAt: null,
        context: {
          autoMatchedCount: autoMatched,
          suggestionsCount: withSuggestions,
        },
      });
    } catch (err) {
      console.error("Failed to create partner matching notification:", err);
    }
  }

  // Chain category matching after partner matching completes
  // Categories can use partnerId for 85% confidence matching
  if (processedTransactionIds.length > 0) {
    try {
      const categoryResult = await matchCategoriesForTransactions(
        userId,
        processedTransactionIds
      );
      console.log(
        `Category matching chained: ${categoryResult.autoMatched} auto-matched, ${categoryResult.withSuggestions} with suggestions`
      );
    } catch (err) {
      console.error("Failed to chain category matching:", err);
    }
  }

  // Chain file matching for auto-matched partners
  // This finds receipts/files for transactions that just got partner-matched
  if (autoMatchedPartnerIds.size > 0) {
    console.log(`Chaining file matching for ${autoMatchedPartnerIds.size} partners`);

    try {
      const { matchFilesForPartnerInternal } = await import("./matchFilesForPartner");

      for (const partnerId of autoMatchedPartnerIds) {
        try {
          const fileResult = await matchFilesForPartnerInternal(userId, partnerId);
          if (fileResult.autoMatched > 0 || fileResult.suggested > 0) {
            console.log(
              `File matching for partner ${partnerId}: ${fileResult.autoMatched} auto-matched, ${fileResult.suggested} suggested`
            );
          }
        } catch (err) {
          console.error(`Failed to chain file matching for partner ${partnerId}:`, err);
        }
      }
    } catch (err) {
      console.error("Failed to import matchFilesForPartnerInternal:", err);
    }
  }

  // Queue agentic partner search for transactions with suggestions but no auto-match
  // Limit to 5 transactions to avoid flooding the worker queue. Never for a
  // background catch-up: a directory change must not cost model calls.
  if (agenticFallback && noAutoMatchTransactions.length > 0 && noAutoMatchTransactions.length <= 5) {
    console.log(`Queueing agentic partner search for ${noAutoMatchTransactions.length} transactions without confident match`);

    for (const { id: txId, data: txData, topConfidence } of noAutoMatchTransactions) {
      try {
        await queueAgenticPartnerSearch(userId, txId, txData, topConfidence);
      } catch (err) {
        console.error(`Failed to queue agentic search for transaction ${txId}:`, err);
      }
    }
  } else if (noAutoMatchTransactions.length > 5) {
    console.log(
      `[PartnerMatch] ${noAutoMatchTransactions.length} transactions without confident match - ` +
      `skipping agentic fallback (batch too large, user should review manually)`
    );
  }

  return {
    processed,
    autoMatched,
    withSuggestions,
  };
}

/**
 * Callable function to manually trigger partner matching
 * Can match specific transactions or all unmatched ones
 */
export const matchPartners = onCall<MatchPartnersRequest>(
  {
    region: "europe-west1",
    memory: "512MiB",
  },
  async (request): Promise<MatchPartnersResponse> => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const { transactionIds, matchAll } = request.data;
    return runPartnerMatching(request.auth.uid, { transactionIds, matchAll, agenticFallback: true });
  }
);
