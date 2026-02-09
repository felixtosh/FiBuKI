import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { VertexAI } from "@google-cloud/vertexai";
import { logAIUsage } from "../utils/ai-usage-logger";
import { matchPatternFlexible } from "../utils/pattern-utils";
import { matchCategoriesForTransactions } from "./matchCategories";
import { learnPatterns, TxSample, CollisionTxSample } from "./patternEngine";

// Using Gemini Flash Lite for pattern learning
const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

// Get project ID from environment
function getProjectId(): string {
  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("Could not determine Google Cloud project ID");
  }
  return projectId;
}

const db = getFirestore();

// ============================================================================
// Types
// ============================================================================

interface LearnCategoryPatternsRequest {
  partnerId: string;
  categoryId: string;
  transactionId?: string;
}

interface CategoryMatchRule {
  categoryId: string;
  categoryTemplateId: string;
  patterns: string[];
  excludePatterns?: string[];
  confidence: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  sourceTransactionIds: string[];
  negativeTransactionIds?: string[];
}

interface LearnCategoryPatternsResponse {
  patternsLearned: number;
  patterns: string[];
  excludePatterns: string[];
  transactionsMatched: number;
}

// ============================================================================
// Cascade Unassign
// ============================================================================

async function cascadeUnassignTransactions(
  userId: string,
  partnerId: string,
  categoryId: string,
  newRule: CategoryMatchRule | null
): Promise<number> {
  const allAssignedSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .where("noReceiptCategoryId", "==", categoryId)
    .limit(500)
    .get();

  const autoAssignedDocs = allAssignedSnapshot.docs.filter((doc) => {
    const data = doc.data();
    const matchedBy = data.noReceiptCategoryMatchedBy;
    return matchedBy === "auto" || !matchedBy;
  });

  if (autoAssignedDocs.length === 0) return 0;

  const batch = db.batch();
  let unassignedCount = 0;

  for (const txDoc of autoAssignedDocs) {
    const txData = txDoc.data();

    if (newRule && newRule.patterns.length > 0) {
      const txName = txData.name || null;
      const txPartner = txData.partner || null;
      const txReference = txData.reference || null;

      const excluded = newRule.excludePatterns?.some((p) =>
        matchPatternFlexible(p.toLowerCase(), txName, txPartner, txReference)
      );

      if (!excluded) {
        const stillMatches = newRule.patterns.some((p) =>
          matchPatternFlexible(p.toLowerCase(), txName, txPartner, txReference)
        );

        if (stillMatches && newRule.confidence >= 89) {
          continue;
        }
      }
    }

    batch.update(txDoc.ref, {
      noReceiptCategoryId: null,
      noReceiptCategoryTemplateId: null,
      noReceiptCategoryMatchedBy: null,
      noReceiptCategoryConfidence: null,
      isComplete: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    unassignedCount++;
  }

  if (unassignedCount > 0) {
    await batch.commit();
    console.log(`Cascade-unassigned ${unassignedCount} transactions that no longer match category rules`);
  }

  return unassignedCount;
}

// ============================================================================
// Cloud Function
// ============================================================================

/**
 * Learn category matching patterns for a partner based on assigned transactions.
 * Called after a user manually assigns/removes a category to/from a transaction with a partner.
 */
export const learnPartnerCategoryPatterns = onCall<LearnCategoryPatternsRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request): Promise<LearnCategoryPatternsResponse> => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { partnerId, categoryId, transactionId } = request.data;

    if (!partnerId || !categoryId) {
      throw new HttpsError("invalid-argument", "partnerId and categoryId are required");
    }

    console.log(`Learning category patterns for partner ${partnerId}, category ${categoryId}, triggered by transaction ${transactionId || "manual"}`);

    try {
      // 1. Fetch the partner
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      if (!partnerDoc.exists) {
        throw new HttpsError("not-found", `Partner ${partnerId} not found`);
      }

      const partnerData = partnerDoc.data()!;
      if (partnerData.userId !== userId) {
        throw new HttpsError("permission-denied", "Cannot access this partner");
      }

      const partnerName = partnerData.name || "";

      // 2. Fetch the category
      const categoryDoc = await db.collection("noReceiptCategories").doc(categoryId).get();
      if (!categoryDoc.exists) {
        throw new HttpsError("not-found", `Category ${categoryId} not found`);
      }

      const categoryData = categoryDoc.data()!;
      if (categoryData.userId !== userId) {
        throw new HttpsError("permission-denied", "Cannot access this category");
      }

      const categoryName = categoryData.name || "";
      const categoryTemplateId = categoryData.templateId || "";

      // 3. Get positive examples: transactions with this partner manually assigned to this category
      const positiveSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("partnerId", "==", partnerId)
        .where("noReceiptCategoryId", "==", categoryId)
        .where("noReceiptCategoryMatchedBy", "in", ["manual", "suggestion"])
        .limit(50)
        .get();

      const positiveTransactions: TxSample[] = positiveSnapshot.docs.map((doc) => ({
        id: doc.id,
        partner: doc.data().partner || null,
        name: doc.data().name || "",
        reference: doc.data().reference || null,
      }));

      // 4. Get negative examples from partner.categoryManualRemovals
      const categoryManualRemovals: Array<{
        transactionId: string;
        categoryId: string;
        partner: string | null;
        name: string;
        reference: string | null;
      }> = (partnerData.categoryManualRemovals || []).filter(
        (r: { categoryId: string }) => r.categoryId === categoryId
      );

      const negativeTransactions: TxSample[] = categoryManualRemovals.map((r) => ({
        id: r.transactionId,
        partner: r.partner || null,
        name: r.name || "",
        reference: r.reference || null,
      }));

      console.log(`Found ${positiveTransactions.length} positive, ${negativeTransactions.length} negative examples`);

      // 5. Handle case where no manual assignments remain
      if (positiveTransactions.length === 0) {
        console.log(`No manual assignments for partner ${partnerId} -> category ${categoryId}, clearing rules`);

        const existingRules: CategoryMatchRule[] = partnerData.categoryMatchRules || [];
        const updatedRules = existingRules.filter((r: CategoryMatchRule) => r.categoryId !== categoryId);

        await partnerDoc.ref.update({
          categoryMatchRules: updatedRules,
          categoryMatchRulesUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, categoryId, null);

        return {
          patternsLearned: 0,
          patterns: [],
          excludePatterns: [],
          transactionsMatched: -unassignedCount,
        };
      }

      // 6. Get collision transactions: same partner, different category (manual/suggestion only)
      const collisionSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("partnerId", "==", partnerId)
        .limit(200)
        .get();

      // Get category names for collision display
      const categoryIds = new Set<string>();
      collisionSnapshot.docs.forEach((doc) => {
        const catId = doc.data().noReceiptCategoryId;
        if (catId && catId !== categoryId) categoryIds.add(catId);
      });

      const categoryMap = new Map<string, string>();
      if (categoryIds.size > 0) {
        const categoryDocs = await Promise.all(
          Array.from(categoryIds).slice(0, 20).map((id) =>
            db.collection("noReceiptCategories").doc(id).get()
          )
        );
        categoryDocs.forEach((doc) => {
          if (doc.exists) {
            categoryMap.set(doc.id, doc.data()!.name || "Unknown");
          }
        });
      }

      const collisionTransactions: CollisionTxSample[] = collisionSnapshot.docs
        .filter((doc) => {
          const data = doc.data();
          const catId = data.noReceiptCategoryId;
          const matchedBy = data.noReceiptCategoryMatchedBy;
          return (
            catId &&
            catId !== categoryId &&
            (matchedBy === "manual" || matchedBy === "suggestion")
          );
        })
        .map((doc) => ({
          id: doc.id,
          partner: doc.data().partner || null,
          name: doc.data().name || "",
          reference: doc.data().reference || null,
          assignedToName: categoryMap.get(doc.data().noReceiptCategoryId) || doc.data().noReceiptCategoryId,
        }));

      console.log(`Found ${collisionTransactions.length} collision transactions`);

      // 7. Build allUserTransactions for dry-run (scoped to this partner)
      const allPartnerTransactions: TxSample[] = collisionSnapshot.docs.map((doc) => ({
        id: doc.id,
        partner: doc.data().partner || null,
        name: doc.data().name || "",
        reference: doc.data().reference || null,
      }));

      // 8. Create Gemini model and run shared pattern engine
      const projectId = getProjectId();
      const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
      const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

      const result = await learnPatterns({
        targetName: `${partnerName} → ${categoryName}`,
        targetAliases: [],
        positiveTransactions,
        negativeTransactions,
        collisionTransactions,
        allUserTransactions: allPartnerTransactions,
        totalTransactionCount: collisionSnapshot.size,
        model,
      });

      // Log AI usage
      await logAIUsage(userId, {
        function: "categoryPatternLearning",
        model: GEMINI_MODEL,
        inputTokens: result.aiUsage.inputTokens,
        outputTokens: result.aiUsage.outputTokens,
        metadata: { partnerId, categoryId },
      });

      // 9. Build and save the rule
      const now = Timestamp.now();
      const sourceTransactionIds = positiveTransactions.map((tx) => tx.id);
      const negativeTransactionIds = negativeTransactions.map((tx) => tx.id);

      // Separate patterns and exclude patterns
      const verifiedPatterns = result.patterns.filter((p) => !p.excludePatterns?.length || p.confidence > 0);
      const allExcludePatterns = result.patterns
        .flatMap((p) => p.excludePatterns || [])
        .filter((v, i, a) => a.indexOf(v) === i); // dedupe

      // Calculate rule confidence
      let ruleConfidence = 0;
      if (verifiedPatterns.length > 0) {
        const avgPatternConfidence = Math.round(
          verifiedPatterns.reduce((sum, p) => sum + p.confidence, 0) / verifiedPatterns.length
        );

        if (allExcludePatterns.length > 0) {
          ruleConfidence = Math.max(90, avgPatternConfidence);
          console.log(`High confidence (${ruleConfidence}%) - exclude patterns resolve ambiguity`);
        } else if (negativeTransactions.length > 0) {
          const penalty = Math.min(15, negativeTransactions.length * 3);
          ruleConfidence = Math.max(70, avgPatternConfidence - penalty);
          console.log(`Reduced confidence: ${avgPatternConfidence}% - ${penalty}% penalty → ${ruleConfidence}%`);
        } else {
          ruleConfidence = avgPatternConfidence;
        }
      }

      const newRule: CategoryMatchRule = {
        categoryId,
        categoryTemplateId,
        patterns: verifiedPatterns.map((p) => p.pattern),
        confidence: ruleConfidence,
        createdAt: now,
        updatedAt: now,
        sourceTransactionIds,
        ...(allExcludePatterns.length > 0 && { excludePatterns: allExcludePatterns }),
        ...(negativeTransactionIds.length > 0 && { negativeTransactionIds }),
      };

      // Update partner's categoryMatchRules
      const existingRules: CategoryMatchRule[] = partnerData.categoryMatchRules || [];
      const updatedRules = existingRules.filter((r: CategoryMatchRule) => r.categoryId !== categoryId);

      if (verifiedPatterns.length > 0) {
        updatedRules.push(newRule);
      }

      await partnerDoc.ref.update({
        categoryMatchRules: updatedRules,
        categoryMatchRulesUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Learned ${verifiedPatterns.length} patterns for partner ${partnerId} -> category ${categoryId}:`,
        verifiedPatterns.map((p) => p.pattern));

      // 10. Cascade-unassign transactions that no longer match
      const unassignedCount = await cascadeUnassignTransactions(
        userId,
        partnerId,
        categoryId,
        verifiedPatterns.length > 0 ? newRule : null
      );
      if (unassignedCount > 0) {
        console.log(`Cascade-unassigned ${unassignedCount} transactions for partner ${partnerId} -> category ${categoryId}`);
      }

      // 11. Re-run category matching for ALL transactions with this partner
      const allPartnerTxSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("partnerId", "==", partnerId)
        .select()
        .limit(500)
        .get();

      const allPartnerTxIds = allPartnerTxSnapshot.docs.map((doc) => doc.id);
      console.log(`Re-matching categories for ${allPartnerTxIds.length} transactions with partner ${partnerId}`);

      let matchedCount = 0;
      if (allPartnerTxIds.length > 0) {
        const rematchResult = await matchCategoriesForTransactions(userId, allPartnerTxIds);
        matchedCount = rematchResult.autoMatched;
        console.log(`Category re-match: ${rematchResult.processed} processed, ${rematchResult.autoMatched} auto-matched, ${rematchResult.withSuggestions} with suggestions`);
      }

      // 12. Create notification if transactions were matched
      if (matchedCount > 0) {
        try {
          await db.collection(`users/${userId}/notifications`).add({
            type: "category_pattern_learned",
            title: `Learned category patterns for ${partnerName}`,
            message: `I learned ${verifiedPatterns.length} pattern${verifiedPatterns.length !== 1 ? "s" : ""} and automatically assigned ${matchedCount} transaction${matchedCount !== 1 ? "s" : ""} to ${categoryName}.`,
            createdAt: FieldValue.serverTimestamp(),
            readAt: null,
            context: {
              partnerId,
              partnerName,
              categoryId,
              categoryName,
              patternsLearned: verifiedPatterns.length,
              transactionsMatched: matchedCount,
            },
          });
        } catch (err) {
          console.error("Failed to create notification:", err);
        }
      }

      return {
        patternsLearned: verifiedPatterns.length,
        patterns: verifiedPatterns.map((p) => p.pattern),
        excludePatterns: allExcludePatterns,
        transactionsMatched: matchedCount,
      };
    } catch (error) {
      if (error instanceof HttpsError) throw error;

      console.error("Error learning category patterns:", error);
      throw new HttpsError(
        "internal",
        `Category pattern learning failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

/**
 * Internal function for calling from other Cloud Functions
 */
export async function learnPartnerCategoryPatternsInternal(
  userId: string,
  partnerId: string,
  categoryId: string
): Promise<LearnCategoryPatternsResponse> {
  const partnerDoc = await db.collection("partners").doc(partnerId).get();
  if (!partnerDoc.exists || partnerDoc.data()?.userId !== userId) {
    return { patternsLearned: 0, patterns: [], excludePatterns: [], transactionsMatched: 0 };
  }

  console.log(`[Internal] Learning category patterns for partner ${partnerId} -> category ${categoryId}`);

  return { patternsLearned: 0, patterns: [], excludePatterns: [], transactionsMatched: 0 };
}
