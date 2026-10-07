import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { AutomationMeta } from "../automation/types";
import {
  matchTransactionToCategories,
  shouldAutoApplyCategory,
  isEligibleForCategoryMatching,
  CategoryData,
  TransactionData,
  CategoryMatchRule,
  CategoryMatchOptions,
} from "../utils/category-matcher";
import { categoryMatchActivity } from "./categoryActivity";

const db = getFirestore();

export const AUTOMATION_META: AutomationMeta = {
  id: "matchCategories",
  name: "Match Categories (Manual)",
  description:
    "Manually triggered category matching for transactions. Matches transactions to no-receipt categories based on partner associations and learned patterns.",
  trigger: {
    type: "callable",
    regions: ["europe-west1"],
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
    {
      entity: "noReceiptCategory",
      fields: ["matchedPartnerIds"],
      action: "update",
    },
  ],
  config: {
    autoApplyThreshold: 89,
  },
  icon: "FolderOpen",
  category: "matching",
};

interface MatchCategoriesRequest {
  transactionIds?: string[];
  matchAll?: boolean;
}

interface MatchCategoriesResponse {
  processed: number;
  autoMatched: number;
  withSuggestions: number;
}

/**
 * Callable function to manually trigger category matching
 * Can match specific transactions or all unmatched ones
 */
export const matchCategories = onCall<MatchCategoriesRequest>(
  {
    region: "europe-west1",
    memory: "512MiB",
  },
  async (request): Promise<MatchCategoriesResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { transactionIds, matchAll } = request.data;

    console.log(`Category matching triggered by user ${userId}`, {
      transactionIds,
      matchAll,
    });

    return matchCategoriesForUser(userId, transactionIds, matchAll);
  }
);

/**
 * Internal helper to match categories for a specific user.
 * Called from the callable function and from matchPartners chaining.
 */
export async function matchCategoriesForUser(
  userId: string,
  transactionIds?: string[],
  matchAll?: boolean
): Promise<MatchCategoriesResponse> {
  // Get user's no-receipt categories
  const categoriesSnapshot = await db
    .collection("noReceiptCategories")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .get();

  if (categoriesSnapshot.empty) {
    console.log(`No active categories found for user ${userId}`);
    return { processed: 0, autoMatched: 0, withSuggestions: 0 };
  }

  // Build map of categoryId -> Set<transactionIds> for manual removals
  const categoryManualRemovals = new Map<string, Set<string>>();

  const categories: CategoryData[] = categoriesSnapshot.docs.map((doc) => {
    const data = doc.data();

    // Track manual removals for this category
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

  console.log(`Found ${categories.length} active categories`);

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
    // Only transactions without category and without files
    const query = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("noReceiptCategoryId", "==", null)
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

  // Collect unique partner IDs from transactions
  const partnerIds = new Set<string>();
  for (const txDoc of transactions) {
    if (!txDoc.exists) continue;
    const partnerId = txDoc.data()?.partnerId;
    if (partnerId) {
      partnerIds.add(partnerId);
    }
  }

  // Fetch partner data to get categoryMatchRules
  const partnerRulesMap = new Map<string, CategoryMatchRule[]>();
  if (partnerIds.size > 0) {
    const partnerDocs = await Promise.all(
      Array.from(partnerIds).slice(0, 100).map((id) =>
        db.collection("partners").doc(id).get()
      )
    );

    for (const partnerDoc of partnerDocs) {
      if (partnerDoc.exists) {
        const partnerData = partnerDoc.data();
        if (partnerData?.categoryMatchRules && partnerData.categoryMatchRules.length > 0) {
          partnerRulesMap.set(partnerDoc.id, partnerData.categoryMatchRules);
        }
      }
    }
    console.log(`Loaded category rules for ${partnerRulesMap.size} partners`);
  }

  let processed = 0;
  let autoMatched = 0;
  let withSuggestions = 0;

  let batch = db.batch();
  let batchCount = 0;

  for (const txDoc of transactions) {
    if (!txDoc.exists) continue;

    const txData = txDoc.data()!;
    const transaction: TransactionData = {
      id: txDoc.id,
      partner: txData.partner || null,
      partnerId: txData.partnerId || null,
      name: txData.name || "",
      reference: txData.reference || null,
      noReceiptCategoryId: txData.noReceiptCategoryId || null,
      fileIds: txData.fileIds || [],
    };

    // Skip over-quota transactions (imported but processing limited)
    if (txData.quotaExceeded) {
      continue;
    }

    // Skip if not eligible (has category or files)
    if (!isEligibleForCategoryMatching(transaction)) {
      continue;
    }

    // Build options with partner-specific category rules
    const options: CategoryMatchOptions = {};
    if (transaction.partnerId) {
      const partnerRules = partnerRulesMap.get(transaction.partnerId);
      if (partnerRules) {
        options.partnerCategoryRules = partnerRules;
      }
    }

    const matches = matchTransactionToCategories(
      transaction,
      categories,
      categoryManualRemovals,
      options
    );
    processed++;

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
        autoMatched++;

        // Link partner to category for future matching (if transaction has a partner)
        if (transaction.partnerId) {
          const category = categories.find((c) => c.id === topMatch.categoryId);
          if (category && !category.matchedPartnerIds.includes(transaction.partnerId)) {
            const categoryRef = db.collection("noReceiptCategories").doc(topMatch.categoryId);
            batch.update(categoryRef, {
              matchedPartnerIds: FieldValue.arrayUnion(transaction.partnerId),
              updatedAt: FieldValue.serverTimestamp(),
            });
            // Update local cache to prevent duplicate arrayUnion in same batch
            category.matchedPartnerIds.push(transaction.partnerId);
            console.log(
              `Auto-linked partner ${transaction.partnerId} to category ${topMatch.templateId}`
            );
            batchCount++;
          }
        }

        console.log(
          `Auto-matched tx ${txDoc.id} to category ${topMatch.templateId} (${topMatch.confidence}%)`
        );
      } else {
        withSuggestions++;
      }

      const logged = categoryMatchActivity(txDoc.data() ?? {}, updates, categories, "category matching");
      if (logged) updates.automationHistory = FieldValue.arrayUnion(logged);
      batch.update(txDoc.ref, updates);
      batchCount++;

      if (batchCount >= 500) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    } else {
      // No matches found - clear any stale suggestions
      // This handles cases where rules now exclude previously suggested categories
      batch.update(txDoc.ref, {
        categorySuggestions: [],
        updatedAt: FieldValue.serverTimestamp(),
      });
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
    `Category matching complete: ${processed} processed, ${autoMatched} auto-matched, ${withSuggestions} with suggestions`
  );

  return {
    processed,
    autoMatched,
    withSuggestions,
  };
}

/**
 * Match categories for specific transaction IDs.
 * Called after partner matching completes.
 */
export async function matchCategoriesForTransactions(
  userId: string,
  transactionIds: string[]
): Promise<MatchCategoriesResponse> {
  if (!transactionIds || transactionIds.length === 0) {
    return { processed: 0, autoMatched: 0, withSuggestions: 0 };
  }

  console.log(
    `Chaining category matching for ${transactionIds.length} transactions`
  );
  return matchCategoriesForUser(userId, transactionIds, false);
}
