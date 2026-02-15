import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { VertexAI } from "@google-cloud/vertexai";
import { logAIUsage } from "../utils/ai-usage-logger";
import { matchPatternFlexible } from "../utils/pattern-utils";
import { learnPatterns, TxSample, CollisionTxSample } from "./patternEngine";

// Using Gemini Flash Lite for pattern learning
const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

// Get project ID from environment (Firebase sets this automatically)
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

interface LearnPatternsRequest {
  partnerId: string;
  transactionId?: string; // Optional: the newly assigned transaction
}

interface ManualRemovalRecord {
  transactionId: string;
  partner: string | null;
  name: string;
}

interface LearnedPattern {
  pattern: string;
  /** DEPRECATED: field is ignored, patterns match all text fields combined */
  field?: "partner" | "name";
  confidence: number;
  createdAt: Timestamp;
  sourceTransactionIds: string[];
  excludePatterns?: string[];
}

interface LearnPatternsResponse {
  patternsLearned: number;
  patterns: Array<{
    pattern: string;
    confidence: number;
  }>;
}

// ============================================================================
// Helper: Re-match unassigned transactions
// ============================================================================

interface MatchedTransaction {
  id: string;
  name: string;
  amount: number;
  partner?: string;
}

interface RematchResult {
  matchedCount: number;
  matchedTransactions: MatchedTransaction[];
}

/**
 * Re-match unassigned transactions against newly learned patterns
 * Auto-assigns if pattern confidence >= 89%
 *
 * IMPORTANT: Skips transactions that are in manualRemovals (user explicitly removed them)
 */
async function rematchUnassignedTransactions(
  userId: string,
  partnerId: string,
  partnerName: string,
  learnedPatterns: LearnedPattern[],
  manualRemovalIds: Set<string> = new Set()
): Promise<RematchResult> {
  const allTxSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .limit(1000)
    .get();

  if (allTxSnapshot.empty) return { matchedCount: 0, matchedTransactions: [] };

  const unassignedDocs = allTxSnapshot.docs.filter((doc) => {
    const data = doc.data();
    return !data.partnerId;
  });

  console.log(`Found ${unassignedDocs.length} unassigned transactions to check`);
  console.log(`Excluding ${manualRemovalIds.size} transactions that user manually removed`);

  if (unassignedDocs.length === 0) return { matchedCount: 0, matchedTransactions: [] };

  const batch = db.batch();
  let matchedCount = 0;
  const matchedTransactions: MatchedTransaction[] = [];

  for (const txDoc of unassignedDocs) {
    const txData = txDoc.data();

    if (manualRemovalIds.has(txDoc.id)) {
      console.log(`  -> SKIPPING tx ${txDoc.id} - user manually removed it from this partner`);
      continue;
    }

    let bestMatch: { confidence: number; pattern: string } | null = null;

    const txName = txData.name || null;
    const txPartner = txData.partner || null;
    const txReference = txData.reference || null;

    if (!txName && !txPartner && !txReference) continue;

    for (const pattern of learnedPatterns) {
      if (matchPatternFlexible(pattern.pattern, txName, txPartner, txReference)) {
        const debugText = [txName, txPartner, txReference].filter(Boolean).join(" | ");
        console.log(`  -> MATCH: "${pattern.pattern}" on fields="${debugText}" (${pattern.confidence}%)`);
        if (!bestMatch || pattern.confidence > bestMatch.confidence) {
          bestMatch = { confidence: pattern.confidence, pattern: pattern.pattern };
        }
      }
    }

    if (bestMatch && bestMatch.confidence >= 89) {
      console.log(`  -> AUTO-ASSIGNING with confidence ${bestMatch.confidence}%`);
      batch.update(txDoc.ref, {
        partnerId: partnerId,
        partnerType: "user",
        partnerMatchConfidence: bestMatch.confidence,
        partnerMatchedBy: "auto",
        partnerSuggestions: [{
          partnerId: partnerId,
          partnerType: "user",
          confidence: bestMatch.confidence,
          source: "pattern",
        }],
        updatedAt: FieldValue.serverTimestamp(),
        automationHistory: FieldValue.arrayUnion({
          type: "partner_assigned",
          ranAt: Timestamp.now(),
          status: "completed",
          actor: "auto",
          level: "outcome",
          forPartnerId: partnerId,
          partnerName: partnerName || null,
          confidence: bestMatch.confidence,
          summary: `Partner "${partnerName || partnerId}" auto-assigned (pattern match)`,
        }),
      });
      matchedCount++;

      if (matchedTransactions.length < 10) {
        matchedTransactions.push({
          id: txDoc.id,
          name: txData.name || txData.partner || "Unknown",
          amount: txData.amount || 0,
          partner: txData.partner,
        });
      }
    } else if (bestMatch) {
      console.log(`  -> Confidence too low (${bestMatch.confidence}% < 89%), skipping auto-assign`);
    }

    if (matchedCount >= 100) break;
  }

  if (matchedCount > 0) {
    await batch.commit();
  }

  return { matchedCount, matchedTransactions };
}

// ============================================================================
// Helper: Cascade unassign auto-matched transactions
// ============================================================================

async function cascadeUnassignTransactions(
  userId: string,
  partnerId: string,
  newPatterns: LearnedPattern[] = [],
  partnerName: string | null = null
): Promise<number> {
  const allAssignedSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .limit(500)
    .get();

  const autoAssignedDocs = allAssignedSnapshot.docs.filter((doc) => {
    const data = doc.data();
    const matchedBy = data.partnerMatchedBy;
    return matchedBy === "auto" || !matchedBy;
  });

  if (autoAssignedDocs.length === 0) return 0;

  console.log(`Found ${autoAssignedDocs.length} auto/legacy-assigned transactions to re-evaluate (of ${allAssignedSnapshot.size} total)`);

  const batch = db.batch();
  let unassignedCount = 0;

  for (const txDoc of autoAssignedDocs) {
    const txData = txDoc.data();

    if (newPatterns.length > 0) {
      const txName = txData.name || null;
      const txPartner = txData.partner || null;
      const txReference = txData.reference || null;

      let stillMatches = false;

      for (const pattern of newPatterns) {
        if (matchPatternFlexible(pattern.pattern, txName, txPartner, txReference)) {
          if (pattern.confidence >= 89) {
            stillMatches = true;
            break;
          }
        }
      }

      if (stillMatches) continue;
    }

    batch.update(txDoc.ref, {
      partnerId: null,
      partnerType: null,
      partnerMatchedBy: null,
      partnerMatchConfidence: null,
      updatedAt: FieldValue.serverTimestamp(),
      automationHistory: FieldValue.arrayUnion({
        type: "partner_removed",
        ranAt: Timestamp.now(),
        status: "completed",
        actor: "auto",
        level: "decision",
        forPartnerId: partnerId,
        partnerName: partnerName || null,
        summary: `Partner "${partnerName || partnerId}" auto-removed (pattern change)`,
      }),
    });
    unassignedCount++;
  }

  if (unassignedCount > 0) {
    await batch.commit();
    console.log(`Cascade-unassigned ${unassignedCount} transactions that no longer match patterns`);
  }

  return unassignedCount;
}

// ============================================================================
// Data Collection Helpers
// ============================================================================

/**
 * Collect all data needed for the shared pattern engine from Firestore.
 * Returns the engine input + partner-specific metadata for post-processing.
 */
async function collectPartnerLearningData(
  userId: string,
  partnerId: string,
  partnerData: FirebaseFirestore.DocumentData
) {
  const partnerName = partnerData.name || "";
  const partnerAliases: string[] = partnerData.aliases || [];

  // Get manual removals (false positives) from partner data
  const manualRemovals: ManualRemovalRecord[] = (partnerData.manualRemovals || []).map(
    (r: { transactionId: string; partner: string | null; name: string }) => ({
      transactionId: r.transactionId,
      partner: r.partner || null,
      name: r.name || "",
    })
  );

  // Fetch ONLY user-assigned transactions (not auto-assigned)
  const assignedSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .where("partnerMatchedBy", "in", ["manual", "suggestion", "ai"])
    .limit(50)
    .get();

  const assignedTransactions: TxSample[] = assignedSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      partner: data.partner || null,
      name: data.name || "",
      reference: data.reference || null,
    };
  });

  // Fetch all user transactions (for collision set + dry-run)
  const allTxSnapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .limit(1000)
    .get();

  const currentGlobalPartnerId = partnerData.globalPartnerId || null;

  // Build partner name map for collision display
  const otherPartnerIds = new Set<string>();
  allTxSnapshot.docs.forEach((doc) => {
    const data = doc.data();
    const pid = data.partnerId;
    if (!pid || pid === partnerId) return;
    if (currentGlobalPartnerId && pid === currentGlobalPartnerId) return;
    if (data.partnerType === "global" && data.partnerMatchedBy !== "manual" && data.partnerMatchedBy !== "suggestion") {
      return;
    }
    otherPartnerIds.add(pid);
  });

  const partnerNameMap = new Map<string, string>();
  if (otherPartnerIds.size > 0) {
    const [partnerDocs, globalDocs] = await Promise.all([
      Promise.all(
        Array.from(otherPartnerIds).slice(0, 50).map((pid) => db.collection("partners").doc(pid).get())
      ),
      Promise.all(
        Array.from(otherPartnerIds).slice(0, 50).map((pid) => db.collection("globalPartners").doc(pid).get())
      ),
    ]);
    partnerDocs.forEach((doc) => {
      if (doc.exists) partnerNameMap.set(doc.id, doc.data()!.name || "Unknown");
    });
    globalDocs.forEach((doc) => {
      if (doc.exists) partnerNameMap.set(doc.id, doc.data()!.name || "Unknown");
    });
  }

  // Build collision set
  const collisionTransactions: CollisionTxSample[] = allTxSnapshot.docs
    .filter((doc) => {
      const data = doc.data();
      const pid = data.partnerId;
      if (!pid || pid === partnerId) return false;
      if (currentGlobalPartnerId && pid === currentGlobalPartnerId) return false;
      if (data.partnerType === "global" && data.partnerMatchedBy !== "manual" && data.partnerMatchedBy !== "suggestion") {
        return false;
      }
      return true;
    })
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        partner: data.partner || null,
        name: data.name || "",
        reference: data.reference || null,
        assignedToName: partnerNameMap.get(data.partnerId) || "Unknown",
      };
    });

  // Build allUserTransactions with assignedOwnerId for dry-run conflict detection
  const allUserTransactions: (TxSample & { assignedOwnerId?: string })[] = allTxSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      partner: data.partner || null,
      name: data.name || "",
      reference: data.reference || null,
      assignedOwnerId: data.partnerId || undefined,
    };
  });

  // Get total transaction count
  const totalTransactionCount = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .count()
    .get()
    .then((snap) => snap.data().count);

  return {
    partnerName,
    partnerAliases,
    manualRemovals,
    assignedTransactions,
    collisionTransactions,
    allUserTransactions,
    totalTransactionCount,
    partnerNameMap,
  };
}

// ============================================================================
// Cloud Function
// ============================================================================

/**
 * Learn matching patterns for a partner based on assigned transactions
 * Called after a user manually assigns a partner to a transaction
 */
export const learnPartnerPatterns = onCall<LearnPatternsRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request): Promise<LearnPatternsResponse> => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { partnerId, transactionId } = request.data;

    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }

    console.log(`Learning patterns for partner ${partnerId}, triggered by transaction ${transactionId || "manual"}`);

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

      // 2. Collect all learning data
      const data = await collectPartnerLearningData(userId, partnerId, partnerData);

      // Handle case where no manual/suggestion assignments remain
      if (data.assignedTransactions.length === 0) {
        console.log(`No manual assignments for partner ${partnerId}, clearing patterns and cascade-unassigning`);

        await partnerDoc.ref.update({
          learnedPatterns: [],
          patternsUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, [], data.partnerName);

        if (unassignedCount > 0) {
          try {
            await db.collection(`users/${userId}/notifications`).add({
              type: "patterns_cleared",
              title: `Patterns cleared for ${data.partnerName}`,
              message: `All manual assignments removed. ${unassignedCount} auto-matched transaction${unassignedCount !== 1 ? "s were" : " was"} unassigned.`,
              createdAt: FieldValue.serverTimestamp(),
              readAt: null,
              context: { partnerId, partnerName: data.partnerName, unassignedCount },
            });
          } catch (err) {
            console.error("Failed to create patterns_cleared notification:", err);
          }
        }

        return { patternsLearned: 0, patterns: [] };
      }

      // 3. Create Gemini model
      const projectId = getProjectId();
      const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
      const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

      // 4. Run shared pattern engine
      const negativeTransactions: TxSample[] = data.manualRemovals.map((r) => ({
        id: r.transactionId,
        partner: r.partner,
        name: r.name,
        reference: null,
      }));

      const result = await learnPatterns({
        targetName: data.partnerName,
        targetAliases: data.partnerAliases,
        positiveTransactions: data.assignedTransactions,
        negativeTransactions,
        collisionTransactions: data.collisionTransactions,
        allUserTransactions: data.allUserTransactions,
        totalTransactionCount: data.totalTransactionCount,
        model,
        ownerId: partnerId,
        ownerNameMap: data.partnerNameMap,
      });

      // Log AI usage
      await logAIUsage(userId, {
        function: "patternLearning",
        model: GEMINI_MODEL,
        inputTokens: result.aiUsage.inputTokens,
        outputTokens: result.aiUsage.outputTokens,
        metadata: { partnerId },
      });

      // Handle no patterns - still try file matching
      if (result.patterns.length === 0) {
        try {
          const { matchFilesForPartnerInternal } = await import("./matchFilesForPartner");
          const fileResult = await matchFilesForPartnerInternal(userId, partnerId);
          if (fileResult.autoMatched > 0 || fileResult.suggested > 0) {
            console.log(`File matching (no patterns) for ${data.partnerName}: ${fileResult.autoMatched} auto-matched`);
          }
        } catch (err) {
          console.error("Failed to run file matching:", err);
        }

        return { patternsLearned: 0, patterns: [] };
      }

      // 5. Convert to LearnedPattern format and store
      const now = Timestamp.now();
      const transactionIds = data.assignedTransactions.map((tx) => tx.id);

      const learnedPatterns: LearnedPattern[] = result.patterns.map((p) => ({
        pattern: p.pattern,
        confidence: p.confidence,
        createdAt: now,
        sourceTransactionIds: transactionIds,
        ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns } : {}),
      }));

      await partnerDoc.ref.update({
        learnedPatterns: learnedPatterns,
        patternsUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Learned ${learnedPatterns.length} patterns for partner ${partnerId}:`,
        learnedPatterns.map((p) => p.pattern));

      // 6. Cascade-unassign auto-matched transactions that no longer match
      const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, learnedPatterns, data.partnerName);
      if (unassignedCount > 0) {
        console.log(`Cascade-unassigned ${unassignedCount} transactions that no longer match updated patterns`);
      }

      // 7. Re-match unassigned transactions with the new patterns
      const manualRemovalIds = new Set(data.manualRemovals.map((r) => r.transactionId));
      const { matchedCount: autoMatched, matchedTransactions } = await rematchUnassignedTransactions(
        userId,
        partnerId,
        data.partnerName,
        learnedPatterns,
        manualRemovalIds
      );
      console.log(`Auto-matched ${autoMatched} additional transactions with new patterns`);

      // 8. Create notification for pattern learning
      if (autoMatched > 0) {
        try {
          const notifRef = await db.collection(`users/${userId}/notifications`).add({
            type: "pattern_learned",
            title: `Learned patterns for ${data.partnerName}`,
            message: `I learned ${learnedPatterns.length} pattern${learnedPatterns.length !== 1 ? "s" : ""} from your assignment and automatically matched ${autoMatched} similar transaction${autoMatched !== 1 ? "s" : ""} to ${data.partnerName}.`,
            createdAt: FieldValue.serverTimestamp(),
            readAt: null,
            context: {
              partnerId,
              partnerName: data.partnerName,
              patternsLearned: learnedPatterns.length,
              transactionsMatched: autoMatched,
            },
            preview: { transactions: matchedTransactions },
          });
          console.log(`Notification created: ${notifRef.id}`);
        } catch (err) {
          console.error("Failed to create pattern learning notification:", err);
        }
      }

      // 9. Chain file matching for partner
      try {
        const { matchFilesForPartnerInternal } = await import("./matchFilesForPartner");
        const fileResult = await matchFilesForPartnerInternal(userId, partnerId);
        if (fileResult.autoMatched > 0 || fileResult.suggested > 0) {
          console.log(
            `File matching chained for ${data.partnerName}: ${fileResult.autoMatched} auto-matched, ${fileResult.suggested} suggested`
          );
        }
      } catch (err) {
        console.error("Failed to chain file matching:", err);
      }

      return {
        patternsLearned: learnedPatterns.length,
        patterns: learnedPatterns.map((p) => ({
          pattern: p.pattern,
          confidence: p.confidence,
        })),
      };
    } catch (error) {
      if (error instanceof HttpsError) throw error;

      console.error("Error learning partner patterns:", error);
      throw new HttpsError(
        "internal",
        `Pattern learning failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
);

// ============================================================================
// Batched Learning (for queue processing)
// ============================================================================

/**
 * Learn patterns for multiple partners in a single operation
 * Called by the learning queue processor
 */
export async function learnPatternsForPartnersBatch(
  userId: string,
  partnerIds: string[]
): Promise<void> {
  console.log(`Batch learning patterns for ${partnerIds.length} partners (user: ${userId})`);

  for (const partnerId of partnerIds) {
    try {
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      if (!partnerDoc.exists) {
        console.log(`Partner ${partnerId} not found, skipping`);
        continue;
      }

      const partnerData = partnerDoc.data()!;
      if (partnerData.userId !== userId) {
        console.log(`Partner ${partnerId} doesn't belong to user ${userId}, skipping`);
        continue;
      }

      // Collect learning data
      const data = await collectPartnerLearningData(userId, partnerId, partnerData);

      // If no user assignments, clear patterns and cascade-unassign
      if (data.assignedTransactions.length === 0) {
        console.log(`No user assignments for partner ${partnerId}, clearing patterns`);

        await partnerDoc.ref.update({
          learnedPatterns: [],
          patternsUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        await cascadeUnassignTransactions(userId, partnerId, [], partnerData.name || null);
        continue;
      }

      // Create Gemini model
      const projectId = getProjectId();
      const vertexAI = new VertexAI({ project: projectId, location: VERTEX_LOCATION });
      const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

      // Run shared pattern engine
      const negativeTransactions: TxSample[] = data.manualRemovals.map((r) => ({
        id: r.transactionId,
        partner: r.partner,
        name: r.name,
        reference: null,
      }));

      const result = await learnPatterns({
        targetName: data.partnerName,
        targetAliases: data.partnerAliases,
        positiveTransactions: data.assignedTransactions,
        negativeTransactions,
        collisionTransactions: data.collisionTransactions,
        allUserTransactions: data.allUserTransactions,
        totalTransactionCount: data.totalTransactionCount,
        model,
        ownerId: partnerId,
        ownerNameMap: data.partnerNameMap,
      });

      // Log AI usage
      await logAIUsage(userId, {
        function: "patternLearning",
        model: GEMINI_MODEL,
        inputTokens: result.aiUsage.inputTokens,
        outputTokens: result.aiUsage.outputTokens,
        metadata: { partnerId },
      });

      if (result.patterns.length === 0) {
        console.log(`No patterns returned for partner ${partnerId}`);
        continue;
      }

      // Convert and store
      const now = Timestamp.now();
      const transactionIds = data.assignedTransactions.map((tx) => tx.id);

      const learnedPatterns: LearnedPattern[] = result.patterns.map((p) => ({
        pattern: p.pattern,
        confidence: p.confidence,
        createdAt: now,
        sourceTransactionIds: transactionIds,
        ...(p.excludePatterns?.length ? { excludePatterns: p.excludePatterns } : {}),
      }));

      await partnerDoc.ref.update({
        learnedPatterns: learnedPatterns,
        patternsUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Learned ${learnedPatterns.length} patterns for ${partnerData.name}:`,
        learnedPatterns.map((p) => p.pattern));

      // Cascade-unassign
      const unassignedCount = await cascadeUnassignTransactions(userId, partnerId, learnedPatterns, partnerData.name || null);
      if (unassignedCount > 0) {
        console.log(`[batch] Cascade-unassigned ${unassignedCount} transactions for ${partnerData.name}`);
      }

      // Rematch
      if (learnedPatterns.length > 0) {
        const manualRemovalIds = new Set(data.manualRemovals.map((r) => r.transactionId));
        const { matchedCount } = await rematchUnassignedTransactions(
          userId,
          partnerId,
          partnerData.name,
          learnedPatterns,
          manualRemovalIds
        );
        console.log(`Auto-matched ${matchedCount} transactions for ${partnerData.name}`);
      }
    } catch (error) {
      console.error(`Error learning patterns for partner ${partnerId}:`, error);
    }
  }
}
