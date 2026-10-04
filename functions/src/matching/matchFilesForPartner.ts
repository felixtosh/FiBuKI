/**
 * Cloud Function: Match Files for Partner
 *
 * Connects a Partner's open Transactions to its Files and to unassigned ones,
 * scored by the matcher (#613) and auto-connected at its threshold, each File
 * to at most one Transaction. What is left goes to an AI pass, then to the
 * agentic receipt search.
 *
 * Called:
 * 1. After learnPartnerPatterns completes (chained)
 * 2. After partner is manually assigned to a transaction
 * 3. Manually via callable function
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { MODELS } from "../utils/models";
import { connectFiles } from "../fileConnections/writer";
import { matchableFiles, pairsAmong, windowAround } from "./matcher";
import { SCORING_CONFIG } from "./transactionScoring";
import { toDateSafe } from "../utils/toDateSafe";

const db = getFirestore();

// === Configuration ===

const CONFIG = {
  /** Max files to process per partner */
  MAX_FILES_PER_PARTNER: 100,
  /** Max transactions to process per partner */
  MAX_TRANSACTIONS_PER_PARTNER: 50,
  /** Minimum unmatched items to trigger AI matching */
  AI_MATCH_MIN_UNMATCHED: 2,
  /** AI match confidence threshold */
  AI_MATCH_CONFIDENCE: 90,
  /** Enable agentic fallback for unmatched transactions */
  ENABLE_AGENTIC_FALLBACK: true,
  /** Max transactions to queue for agentic fallback per run */
  AGENTIC_FALLBACK_MAX_QUEUE: 10,
};

// === Types ===

interface MatchFilesForPartnerRequest {
  partnerId: string;
  transactionIds?: string[]; // Optional: specific transactions to match
}

interface MatchFilesForPartnerResponse {
  processed: number;
  autoMatched: number;
  suggested: number;
}

// === AI Matching ===

interface AIMatch {
  fileId: string;
  transactionId: string;
  reasoning: string;
}

/**
 * Use Gemini AI to match files to transactions when score-based matching is insufficient.
 * Analyzes invoice details and transaction descriptions to find matches.
 */
async function matchWithAI(
  files: FirebaseFirestore.QueryDocumentSnapshot[],
  transactions: FirebaseFirestore.QueryDocumentSnapshot[],
  partnerName: string
): Promise<AIMatch[]> {
  const { VertexAI } = await import("@google-cloud/vertexai");

  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    console.log("Google Cloud project ID not set, skipping AI matching");
    return [];
  }

  const vertexAI = new VertexAI({
    project: projectId,
    location: process.env.VERTEX_LOCATION || "europe-west1",
  });

  const model = vertexAI.getGenerativeModel({ model: MODELS.geminiFlash });

  // Build file summaries
  const fileSummaries = files.map((doc) => {
    const data = doc.data();
    const amount = data.extractedAmount
      ? `${(data.extractedAmount / 100).toFixed(2)} ${data.extractedCurrency || "EUR"}`
      : "unknown";
    const date = data.extractedDate
      ? data.extractedDate.toDate().toISOString().split("T")[0]
      : "unknown";

    return {
      id: doc.id,
      fileName: data.fileName || "unknown",
      amount,
      date,
      invoiceNumber: data.extractedInvoiceNumber || null,
      description: data.extractedDescription?.substring(0, 200) || null,
    };
  });

  // Build transaction summaries
  const txSummaries = transactions.map((doc) => {
    const data = doc.data();
    const amount = `${(data.amount / 100).toFixed(2)} ${data.currency || "EUR"}`;
    const date = data.date
      ? data.date.toDate().toISOString().split("T")[0]
      : "unknown";

    return {
      id: doc.id,
      amount,
      date,
      description: data.name || "",
      reference: data.reference || null,
    };
  });

  const prompt = `You are matching invoices/receipts to bank transactions for the company "${partnerName}".

FILES (invoices/receipts):
${JSON.stringify(fileSummaries, null, 2)}

TRANSACTIONS (bank records):
${JSON.stringify(txSummaries, null, 2)}

Match each file to the most likely transaction. Consider:
1. Amount match (exact or very close, accounting for currency/rounding)
2. Date proximity (invoice date should be close to transaction date)
3. Reference numbers that appear in both
4. Description matches

Return ONLY a JSON array of confident matches. Only include matches where you're highly confident.
Each match should have: fileId, transactionId, reasoning (brief explanation).

If no confident matches can be made, return an empty array [].

Response format (JSON only, no markdown):
[{"fileId": "...", "transactionId": "...", "reasoning": "..."}]`;

  try {
    const result = await model.generateContent({
      generationConfig: { responseMimeType: "application/json" },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const responseText =
      result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]";

    // Parse JSON response (handle markdown code blocks)
    let jsonText = responseText;
    if (responseText.startsWith("```")) {
      const match = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        jsonText = match[1].trim();
      }
    }

    const matches = JSON.parse(jsonText) as AIMatch[];

    // Validate matches - ensure file and transaction IDs exist
    const validFileIds = new Set(files.map((f) => f.id));
    const validTxIds = new Set(transactions.map((t) => t.id));

    return matches.filter(
      (m) =>
        m.fileId &&
        m.transactionId &&
        validFileIds.has(m.fileId) &&
        validTxIds.has(m.transactionId)
    );
  } catch (error) {
    console.error("Failed to parse AI matching response:", error);
    return [];
  }
}

// === Main Matching Logic ===

/**
 * Match files to transactions for a specific partner
 * Called after partner pattern learning or when partner is assigned
 */
export async function matchFilesForPartnerInternal(
  userId: string,
  partnerId: string,
  specificTransactionIds?: string[]
): Promise<MatchFilesForPartnerResponse> {
  console.log(`Starting file matching for partner ${partnerId} (user: ${userId})`);

  // 1. Get the partner
  const partnerDoc = await db.collection("partners").doc(partnerId).get();
  if (!partnerDoc.exists) {
    console.log(`Partner ${partnerId} not found`);
    return { processed: 0, autoMatched: 0, suggested: 0 };
  }

  const partnerData = partnerDoc.data()!;
  if (partnerData.userId !== userId) {
    console.log(`Partner ${partnerId} doesn't belong to user ${userId}`);
    return { processed: 0, autoMatched: 0, suggested: 0 };
  }

  const partnerName = partnerData.name || "Unknown";

  // 2. Get transactions with this partner that need files
  let transactionsQuery = db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId);

  let transactions: FirebaseFirestore.QueryDocumentSnapshot[];

  if (specificTransactionIds && specificTransactionIds.length > 0) {
    // Fetch specific transactions
    const docs = await Promise.all(
      specificTransactionIds.map((id) => db.collection("transactions").doc(id).get())
    );
    transactions = docs.filter(
      (doc) =>
        doc.exists &&
        doc.data()?.userId === userId &&
        doc.data()?.partnerId === partnerId
    ) as FirebaseFirestore.QueryDocumentSnapshot[];
  } else {
    // Get all transactions for this partner
    const snapshot = await transactionsQuery
      .limit(CONFIG.MAX_TRANSACTIONS_PER_PARTNER)
      .get();
    transactions = snapshot.docs;
  }

  // Filter to transactions without files (or without noReceiptCategoryId)
  const unfiledTransactions = transactions.filter((doc) => {
    const data = doc.data();
    const hasFiles = data.fileIds && data.fileIds.length > 0;
    const hasNoReceiptCategory = !!data.noReceiptCategoryId;
    return !hasFiles && !hasNoReceiptCategory;
  });

  if (unfiledTransactions.length === 0) {
    console.log(`No unfiled transactions for partner ${partnerName}`);
    return { processed: 0, autoMatched: 0, suggested: 0 };
  }

  console.log(`Found ${unfiledTransactions.length} unfiled transactions for partner ${partnerName}`);

  // 3. Get candidate files: this Partner's, and unassigned ones dated near
  // the Transactions. Which pairs among them are possible (eligibility, the
  // date window, Rejections) and what each scores is the matcher's (#613).
  const span = windowAround(
    unfiledTransactions.map((doc) => toDateSafe(doc.data().date)).filter((d): d is Date => d !== null)
  );

  const [partnerFilesSnapshot, unassignedFilesSnapshot] = await Promise.all([
    db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", partnerId)
      .where("extractionComplete", "==", true)
      .limit(CONFIG.MAX_FILES_PER_PARTNER)
      .get(),
    span
      ? db
          .collection("files")
          .where("userId", "==", userId)
          .where("extractionComplete", "==", true)
          .where("extractedDate", ">=", span.start)
          .where("extractedDate", "<=", span.end)
          .limit(CONFIG.MAX_FILES_PER_PARTNER)
          .get()
      : null,
  ]);

  // Merge and deduplicate files
  const fileMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  for (const doc of partnerFilesSnapshot.docs) {
    fileMap.set(doc.id, doc);
  }
  for (const doc of unassignedFilesSnapshot?.docs ?? []) {
    const data = doc.data();
    // Only include unassigned files (no partnerId or partnerId matches)
    if (!data.partnerId || data.partnerId === partnerId) {
      fileMap.set(doc.id, doc);
    }
  }

  // Unconnected, and possible at all.
  const unconnectedFiles = await matchableFiles(
    db,
    Array.from(fileMap.values())
      .filter((doc) => !(Array.isArray(doc.data().transactionIds) && doc.data().transactionIds.length > 0))
      .map((doc) => ({ id: doc.id, data: doc.data(), doc }))
  );

  if (unconnectedFiles.length === 0) {
    console.log(`No candidate files found for partner ${partnerName}`);
    return { processed: 0, autoMatched: 0, suggested: 0 };
  }

  console.log(`Found ${unconnectedFiles.length} candidate files to match`);

  // 4. Score all file-transaction pairs with the matcher. Its own points
  // formula is gone: "same Partner" is worth what the matcher gives it, so a
  // pair connects on the same evidence the upload trigger needs.
  const allScores = (await pairsAmong(db, userId, unconnectedFiles, unfiledTransactions)).filter(
    (m) => m.confidence >= SCORING_CONFIG.SUGGESTION_THRESHOLD
  );

  if (allScores.length === 0) {
    console.log(`No file-transaction matches above threshold for partner ${partnerName}`);
    return { processed: unfiledTransactions.length, autoMatched: 0, suggested: 0 };
  }

  console.log(`Found ${allScores.length} potential matches, top score: ${allScores[0]?.confidence}`);

  // 5. Create connections for auto-matches
  // Greedy matching: each file to at most one transaction, each transaction to at most one file
  const usedFiles = new Set<string>();
  const usedTransactions = new Set<string>();
  const chosen: typeof allScores = [];
  let autoMatched = 0;
  let suggested = 0;

  for (const match of allScores) {
    if (usedFiles.has(match.fileId) || usedTransactions.has(match.transactionId)) {
      continue;
    }

    if (match.confidence >= SCORING_CONFIG.AUTO_MATCH_THRESHOLD) {
      chosen.push(match);
      usedFiles.add(match.fileId);
      usedTransactions.add(match.transactionId);
    } else {
      // Counted only; the File's own suggestions are the trigger's.
      suggested++;
    }
  }

  // Through the File Connection writer (#612), which batches a run of any
  // size and refuses what an automated connect may not do.
  const scoreOutcomes = await connectFiles(
    db,
    userId,
    chosen.map((match) => ({
      fileId: match.fileId,
      transactionId: match.transactionId,
      matchSources: match.matchSources,
      matchConfidence: match.confidence,
      scoreBreakdown: match.breakdown,
    })),
    { origin: "auto" }
  );
  scoreOutcomes.forEach((outcome, i) => {
    if (outcome.status === "connected") {
      autoMatched++;
    } else if (outcome.status === "refused") {
      // Free for the AI pass, which the writer refuses the same way.
      usedFiles.delete(chosen[i].fileId);
      usedTransactions.delete(chosen[i].transactionId);
    }
  });

  console.log(
    `Score-based matching for partner ${partnerName}: ` +
      `${autoMatched} auto-matched, ${suggested} suggested`
  );

  // 6. AI fallback matching for remaining unmatched items
  // If there are multiple unmatched files AND transactions, use AI to match them
  const remainingUnmatchedFiles = unconnectedFiles
    .filter((f) => !usedFiles.has(f.id))
    .map((f) => f.doc);
  const remainingUnmatchedTxs = unfiledTransactions.filter(
    (doc) => !usedTransactions.has(doc.id)
  );

  if (
    remainingUnmatchedFiles.length >= CONFIG.AI_MATCH_MIN_UNMATCHED &&
    remainingUnmatchedTxs.length >= CONFIG.AI_MATCH_MIN_UNMATCHED
  ) {
    console.log(
      `Attempting AI matching for ${remainingUnmatchedFiles.length} files and ${remainingUnmatchedTxs.length} transactions`
    );

    try {
      const aiMatches = await matchWithAI(
        remainingUnmatchedFiles,
        remainingUnmatchedTxs,
        partnerName
      );

      const aiPairs = aiMatches.filter((match) => {
        // Skip if already used (shouldn't happen but be safe)
        if (usedFiles.has(match.fileId) || usedTransactions.has(match.transactionId)) return false;
        usedFiles.add(match.fileId);
        usedTransactions.add(match.transactionId);
        return true;
      });
      if (aiPairs.length > 0) {
        const aiOutcomes = await connectFiles(
          db,
          userId,
          aiPairs.map((match) => ({
            fileId: match.fileId,
            transactionId: match.transactionId,
            matchSources: ["ai_analysis"],
            matchConfidence: CONFIG.AI_MATCH_CONFIDENCE,
            aiReasoning: match.reasoning,
          })),
          { origin: "ai" }
        );
        const aiConnected = aiOutcomes.filter((o) => o.status === "connected").length;
        autoMatched += aiConnected;
        console.log(`AI matching: ${aiConnected} additional matches`);
      }
    } catch (error) {
      console.error("AI matching failed:", error);
      // Non-critical - continue without AI matches
    }
  }

  console.log(
    `File matching complete for partner ${partnerName}: ` +
      `${autoMatched} total auto-matched, ${suggested} suggested`
  );

  // 7. Create notification if matches found
  if (autoMatched > 0) {
    try {
      await db.collection(`users/${userId}/notifications`).add({
        type: "file_partner_match",
        title: `Matched ${autoMatched} file${autoMatched !== 1 ? "s" : ""} to ${partnerName}`,
        message: `Based on your past behavior, I automatically connected ${autoMatched} receipt${autoMatched !== 1 ? "s" : ""} to transactions from ${partnerName}.`,
        createdAt: FieldValue.serverTimestamp(),
        readAt: null,
        context: {
          partnerId,
          partnerName,
          autoMatchCount: autoMatched,
          suggestionsCount: suggested,
        },
      });
    } catch (err) {
      console.error("Failed to create file matching notification:", err);
    }
  }

  // 8. Queue agentic fallback for remaining unmatched transactions
  // After scoring and AI matching, any transactions still without files get queued
  // for the agentic receipt search worker (searches Gmail, local files, etc.)
  if (CONFIG.ENABLE_AGENTIC_FALLBACK) {
    const finallyUnmatchedTxs = unfiledTransactions.filter(
      (doc) => !usedTransactions.has(doc.id)
    );

    if (finallyUnmatchedTxs.length > 0) {
      console.log(
        `Queueing ${Math.min(finallyUnmatchedTxs.length, CONFIG.AGENTIC_FALLBACK_MAX_QUEUE)} ` +
          `of ${finallyUnmatchedTxs.length} unmatched transactions for agentic receipt search`
      );

      // Dynamically import to avoid circular dependencies
      const { queueReceiptSearchForTransaction } = await import(
        "../workers/runReceiptSearchForTransaction"
      );

      // Queue up to max limit (avoid overwhelming the system)
      const toQueue = finallyUnmatchedTxs.slice(0, CONFIG.AGENTIC_FALLBACK_MAX_QUEUE);
      let queued = 0;

      for (const txDoc of toQueue) {
        try {
          const result = await queueReceiptSearchForTransaction({
            transactionId: txDoc.id,
            userId,
            partnerId,
          });

          if (result.success && !result.skipped) {
            queued++;
          }
        } catch (err) {
          console.error(`Failed to queue agentic search for tx ${txDoc.id}:`, err);
        }
      }

      if (queued > 0) {
        console.log(`Queued ${queued} transactions for agentic receipt search`);
      }
    }
  }

  return {
    processed: unfiledTransactions.length,
    autoMatched,
    suggested,
  };
}

// === Callable Function ===

/**
 * Callable function to manually trigger file matching for a partner
 */
export const matchFilesForPartner = onCall<MatchFilesForPartnerRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request): Promise<MatchFilesForPartnerResponse> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { partnerId, transactionIds } = request.data;

    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }

    return matchFilesForPartnerInternal(userId, partnerId, transactionIds);
  }
);
