/**
 * Cloud Function: Match File to Transactions
 *
 * Triggered when a file's extraction completes.
 * Scores potential transaction matches and creates auto-connections.
 *
 * WORKER INTEGRATION NOTE:
 * This trigger can be replaced with a worker-based approach that:
 * 1. Uses LangGraph agent with search tools
 * 2. Searches both local files AND Gmail for matches
 * 3. Creates activity log with full reasoning transcript
 *
 * To enable worker-based matching:
 * 1. Set user preference or feature flag
 * 2. Call triggerFileMatchingWorkerCallable instead of runTransactionMatching
 * 3. Worker creates notification with transcript in users/{userId}/notifications
 *
 * The worker approach is implemented in:
 * - lib/agent/worker-graph.ts (LangGraph worker)
 * - app/api/worker/route.ts (API endpoint)
 * - hooks/use-worker.ts (frontend hook)
 */

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  SCORING_CONFIG,
  scoreTransaction,
  formatScoreBreakdown,
  TransactionMatchScore,
  TransactionMatchSource,
  ScoringOptions,
} from "./transactionScoring";
import { AutomationMeta } from "../automation/types";
import { checkAIBudget } from "../billing/checkAIBudget";
import { isPassiveMode } from "../utils/checkAutomationMode";

// =============================================================================
// AUTOMATION METADATA
// =============================================================================

export const AUTOMATION_META: AutomationMeta = {
  id: "matchFileTransactions",
  name: "Match File to Transactions",
  description:
    "Scores file against transactions by amount, date, and partner overlap; auto-connects high-confidence matches",
  trigger: {
    type: "document_update",
    collection: "files",
    conditions: [
      { field: "partnerMatchComplete", from: false, to: true },
    ],
  },
  effects: [
    {
      entity: "file",
      fields: [
        "transactionIds",
        "transactionSuggestions",
        "transactionMatchComplete",
        "transactionMatchedAt",
      ],
      action: "update",
    },
    {
      entity: "transaction",
      fields: ["fileIds", "partnerId", "partnerType", "partnerMatchedBy"],
      action: "update",
    },
    {
      entity: "fileConnection",
      fields: ["fileId", "transactionId", "connectionType", "matchConfidence"],
      action: "create",
    },
    {
      entity: "notification",
      fields: ["type", "title", "message", "transcript"],
      action: "create",
    },
    {
      entity: "workerRequest",
      fields: ["workerType", "initialPrompt", "triggerContext"],
      action: "create",
    },
  ],
  learns: [
    {
      entity: "partner",
      fields: ["emailDomains"],
      description: "Learns Gmail sender domain from successful auto-matches",
    },
  ],
  config: {
    autoMatchThreshold: SCORING_CONFIG.AUTO_MATCH_THRESHOLD,
    suggestionThreshold: SCORING_CONFIG.SUGGESTION_THRESHOLD,
    dateRangeDays: SCORING_CONFIG.DATE_RANGE_DAYS,
    maxSuggestions: SCORING_CONFIG.MAX_SUGGESTIONS,
  },
  icon: "FileSearch",
  category: "matching",
  aiPowered: true,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

const db = getFirestore();

// Use shared config
const CONFIG = SCORING_CONFIG;

// === Types ===

interface TransactionSuggestion {
  transactionId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  preview: {
    date: Timestamp;
    amount: number;
    currency: string;
    name: string;
    partner: string | null;
  };
}

interface PartnerBatchStateDoc {
  userId: string;
  partnerId: string;
  status: "idle" | "pending" | "processing";
  activeRequestId: string | null;
  activeRunId: string | null;
  queuedFileIds: string[];
  inflightFileIds: string[];
  rerunNeeded: boolean;
  version: number;
  lastCompletedAt: Timestamp | null;
  nextEligibleAt: Timestamp | null;
  failureCount: number;
  lastSummary?: string | null;
  lastError?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

const PARTNER_BATCH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// === Transcript Builder ===

/**
 * Build a synthetic transcript that shows what the matching process did.
 * This gives users visibility into the matching logic without requiring
 * the full LangGraph worker.
 */
function buildMatchingTranscript(
  fileData: FirebaseFirestore.DocumentData,
  fileId: string,
  candidateCount: number,
  matches: TransactionMatchScore[],
  autoMatches: TransactionMatchScore[],
  suggestions: TransactionSuggestion[],
  elapsedMs: number
): Array<{
  id: string;
  role: "assistant";
  content: string;
  createdAt: Timestamp;
}> {
  const messages: Array<{
    id: string;
    role: "assistant";
    content: string;
    createdAt: Timestamp;
  }> = [];

  const now = Timestamp.now();
  let msgIndex = 0;

  const addMessage = (content: string) => {
    messages.push({
      id: `msg_${msgIndex++}`,
      role: "assistant",
      content,
      createdAt: now,
    });
  };

  // Step 1: File info
  const fileAmount = fileData.extractedAmount != null
    ? `${(fileData.extractedAmount / 100).toFixed(2)} EUR`
    : "unknown";
  const fileDate = fileData.extractedDate
    ? fileData.extractedDate.toDate().toISOString().split("T")[0]
    : "unknown";
  const filePartner = fileData.extractedPartner || fileData.partnerName || "unknown";

  addMessage(
    `Searching for matches for **${fileData.fileName || fileId}**\n` +
    `- Amount: ${fileAmount}\n` +
    `- Date: ${fileDate}\n` +
    `- Partner: ${filePartner}`
  );

  // Step 2: Search scope
  addMessage(`Scanning ${candidateCount} candidate transactions...`);

  // Step 3: Results
  if (matches.length === 0) {
    addMessage(`No matches found above 50% confidence threshold.`);
  } else {
    // Show top matches
    const topMatches = matches.slice(0, 3);
    let matchList = topMatches.map((m) => {
      const txAmount = (m.preview.amount / 100).toFixed(2);
      const txDate = m.preview.date.toDate().toISOString().split("T")[0];
      return `- **${m.confidence}%** - ${m.preview.name} (${txAmount} EUR, ${txDate})`;
    }).join("\n");

    if (matches.length > 3) {
      matchList += `\n- ... and ${matches.length - 3} more`;
    }

    addMessage(`Found ${matches.length} potential matches:\n${matchList}`);
  }

  // Step 4: Actions taken
  if (autoMatches.length > 0) {
    const connectedList = autoMatches.map((m) => {
      const txAmount = (m.preview.amount / 100).toFixed(2);
      return `- ${m.preview.name} (${txAmount} EUR) - ${m.confidence}% confidence`;
    }).join("\n");

    addMessage(
      `**Auto-connected ${autoMatches.length} transaction${autoMatches.length !== 1 ? "s" : ""}:**\n${connectedList}`
    );
  }

  if (suggestions.length > autoMatches.length) {
    const suggestionCount = suggestions.length - autoMatches.length;
    addMessage(
      `${suggestionCount} suggestion${suggestionCount !== 1 ? "s" : ""} saved for your review (50-84% confidence).`
    );
  }

  // Step 5: Summary
  const summary = autoMatches.length > 0
    ? `Done! Matched ${autoMatches.length} transaction${autoMatches.length !== 1 ? "s" : ""} in ${elapsedMs}ms.`
    : suggestions.length > 0
      ? `Done! ${suggestions.length} suggestion${suggestions.length !== 1 ? "s" : ""} ready for review.`
      : `Done! No suitable matches found.`;

  addMessage(summary);

  return messages;
}

// === Email Domain Learning ===

/**
 * Learn email domain from successful auto-match.
 * When a file with a Gmail sender is matched to a transaction with a partner,
 * we add the sender domain to the partner's known email domains.
 *
 * This enables future auto-matching: files from known domains get a confidence boost.
 */
async function learnEmailDomainFromMatch(
  fileData: FirebaseFirestore.DocumentData,
  transactionId: string
): Promise<void> {
  // Only learn from Gmail files with sender domain
  if (!fileData.gmailSenderDomain) {
    return;
  }

  // Get transaction to check for partner
  const txDoc = await db.collection("transactions").doc(transactionId).get();
  if (!txDoc.exists) {
    return;
  }

  const txData = txDoc.data()!;
  if (!txData.partnerId) {
    return;
  }

  const domain = fileData.gmailSenderDomain.toLowerCase().trim();

  // Get partner and check if domain already known
  const partnerDoc = await db.collection("partners").doc(txData.partnerId).get();
  if (!partnerDoc.exists) {
    return;
  }

  const partnerData = partnerDoc.data()!;
  const existingDomains: string[] = partnerData.emailDomains || [];

  if (existingDomains.includes(domain)) {
    return; // Already known
  }

  // Add domain to partner
  await partnerDoc.ref.update({
    emailDomains: FieldValue.arrayUnion(domain),
    emailDomainsUpdatedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  console.log(
    `[EmailDomain] Learned domain "${domain}" for partner ${txData.partnerId} ` +
    `from file ${fileData.fileName} matched to transaction ${transactionId}`
  );
}

// === Partner Priority Resolution ===

type PartnerMatchedBy = "manual" | "suggestion" | "auto" | null;

function resolvePartnerConflict(
  filePartnerId: string | null,
  fileMatchedBy: PartnerMatchedBy,
  txPartnerId: string | null,
  txMatchedBy: PartnerMatchedBy
): { winnerId: string | null; source: "file" | "transaction" | null } {
  if (!filePartnerId && !txPartnerId) {
    return { winnerId: null, source: null };
  }

  if (filePartnerId && !txPartnerId) {
    return { winnerId: filePartnerId, source: "file" };
  }
  if (txPartnerId && !filePartnerId) {
    return { winnerId: txPartnerId, source: "transaction" };
  }

  const fileIsManual = fileMatchedBy === "manual";
  const txIsManual = txMatchedBy === "manual";

  if (fileIsManual && !txIsManual) {
    return { winnerId: filePartnerId!, source: "file" };
  }
  if (txIsManual && !fileIsManual) {
    return { winnerId: txPartnerId!, source: "transaction" };
  }

  if (fileIsManual && txIsManual) {
    return { winnerId: txPartnerId!, source: "transaction" };
  }

  // Both auto/suggestion - file wins
  return { winnerId: filePartnerId!, source: "file" };
}

// === Main Function ===

export async function runTransactionMatching(
  fileId: string,
  fileData: FirebaseFirestore.DocumentData
): Promise<void> {
  // Skip soft-deleted files
  if (fileData.deletedAt) {
    console.log(`[TxMatch] Skipping deleted file: ${fileId}`);
    return;
  }

  // Skip "Not Invoice" files - no transaction matching needed
  if (fileData.isNotInvoice === true) {
    console.log(`[TxMatch] File ${fileId} is not an invoice, skipping transaction matching`);
    await db.collection("files").doc(fileId).update({
      transactionMatchComplete: true,
      transactionMatchedAt: Timestamp.now(),
      transactionSuggestions: [],
      updatedAt: Timestamp.now(),
    });
    return;
  }

  const userId = fileData.userId;
  const t0 = Date.now();

  // Log file info
  const fileAmount = fileData.extractedAmount != null ? (fileData.extractedAmount / 100).toFixed(2) : "N/A";
  const fileDate = fileData.extractedDate ? fileData.extractedDate.toDate().toISOString().split("T")[0] : "N/A";
  console.log(`[TxMatch] File: ${fileData.fileName || fileId}`);
  console.log(`[TxMatch]   Amount: ${fileAmount} ${fileData.extractedCurrency || "EUR"}, Date: ${fileDate}`);
  console.log(`[TxMatch]   Extracted partner: "${fileData.extractedPartner || "none"}"`);
  console.log(`[TxMatch]   Assigned partnerId: ${fileData.partnerId || "none"}`);

  // Get candidate transactions (within date range)
  let transactions: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let dateRangeStr = "";

  if (fileData.extractedDate) {
    const centerDate = fileData.extractedDate.toDate();
    const startDate = new Date(centerDate);
    startDate.setDate(startDate.getDate() - CONFIG.DATE_RANGE_DAYS);
    const endDate = new Date(centerDate);
    endDate.setDate(endDate.getDate() + CONFIG.DATE_RANGE_DAYS);
    dateRangeStr = `${startDate.toISOString().split("T")[0]} to ${endDate.toISOString().split("T")[0]}`;

    const snapshot = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("date", ">=", Timestamp.fromDate(startDate))
      .where("date", "<=", Timestamp.fromDate(endDate))
      .orderBy("date", "desc")
      .limit(500)
      .get();

    transactions = snapshot.docs;
  } else {
    // No date? Query recent transactions
    dateRangeStr = "recent (no file date)";
    const snapshot = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .orderBy("date", "desc")
      .limit(200)
      .get();

    transactions = snapshot.docs;
  }

  console.log(`[TxMatch] Found ${transactions.length} candidate transactions (${dateRangeStr})`);

  // If there's a precision search hint with a transaction ID, ensure it's in the candidate set
  // The hint means automation already validated this transaction is relevant (by amount/partner search)
  // but it might be outside the date range
  if (fileData.precisionSearchHint?.transactionId) {
    const hintedTxId = fileData.precisionSearchHint.transactionId;
    const alreadyIncluded = transactions.some(doc => doc.id === hintedTxId);

    if (!alreadyIncluded) {
      const hintedTxDoc = await db.collection("transactions").doc(hintedTxId).get();
      if (hintedTxDoc.exists && hintedTxDoc.data()?.userId === userId) {
        transactions.push(hintedTxDoc as FirebaseFirestore.QueryDocumentSnapshot);
        console.log(`[TxMatch] Added hinted transaction ${hintedTxId} to candidates (was outside date range)`);
      }
    }
  }

  if (transactions.length === 0) {
    await db.collection("files").doc(fileId).update({
      transactionMatchComplete: true,
      transactionMatchedAt: Timestamp.now(),
      transactionSuggestions: [],
      updatedAt: Timestamp.now(),
    });
    console.log(`[TxMatch] No transactions found, marking complete`);
    return;
  }

  // Fetch partner aliases, billing cycle, and scoring weights if file has an assigned partner
  let partnerAliases: string[] = [];
  let scoringOptions: ScoringOptions | undefined;
  if (fileData.partnerId) {
    try {
      const partnerDoc = await db.collection("partners").doc(fileData.partnerId).get();
      if (partnerDoc.exists) {
        const partnerData = partnerDoc.data()!;
        // Collect partner name + all aliases for matching
        partnerAliases = [
          partnerData.name,
          ...(partnerData.aliases || []),
        ].filter(Boolean);
        console.log(`[TxMatch] Partner aliases: [${partnerAliases.map(a => `"${a}"`).join(", ")}]`);

        // Read billing cycle and scoring weights for enhanced scoring
        const bc = partnerData.billingCycle;
        const sw = partnerData.scoringWeights;
        if (bc || sw) {
          scoringOptions = {};
          if (bc) {
            scoringOptions.billingCycle = {
              invoiceToTransactionDelay: bc.invoiceToTransactionDelay,
              delayVariance: bc.delayVariance,
            };
            console.log(`[TxMatch] Using billing cycle: delay=${bc.invoiceToTransactionDelay}d ±${bc.delayVariance}d`);
          }
          if (sw) {
            scoringOptions.weights = {
              amountWeight: sw.amountWeight,
              dateWeight: sw.dateWeight,
              partnerWeight: sw.partnerWeight,
            };
            console.log(`[TxMatch] Using scoring weights: amt=${sw.amountWeight} date=${sw.dateWeight} partner=${sw.partnerWeight}`);
          }
        }
      }
    } catch (error) {
      console.warn("[TxMatch] Failed to fetch partner data:", error);
    }
  }

  // Exclude already connected transactions and transactions that rejected this file
  const connectedIds = new Set(fileData.transactionIds || []);
  let rejectedCount = 0;

  // Filter out transactions that have rejected this file
  // Handles both legacy rejectedFileIds (string[]) and new rejectedFiles (object[])
  const eligibleTransactions = transactions.filter((doc) => {
    if (connectedIds.has(doc.id)) return false;
    const txData = doc.data();
    // Skip over-quota transactions (soft limit)
    if (txData.quotaExceeded) return false;
    const rejectedFileIds: string[] = txData.rejectedFileIds || [];
    const rejectedFiles: Array<{ fileId: string }> = txData.rejectedFiles || [];
    const isRejected =
      rejectedFileIds.includes(fileId) ||
      rejectedFiles.some((r) => r.fileId === fileId);
    if (isRejected) {
      rejectedCount++;
      return false;
    }
    return true;
  });

  const candidateCount = eligibleTransactions.length;
  console.log(`[TxMatch] Scoring ${candidateCount} transactions (${connectedIds.size} connected, ${rejectedCount} rejected this file)`);

  // Score each transaction
  const allScores = eligibleTransactions
    .map((doc) => {
      const txData = doc.data();
      return scoreTransaction(
        {
          extractedAmount: fileData.extractedAmount,
          extractedCurrency: fileData.extractedCurrency,
          extractedDate: fileData.extractedDate,
          extractedPartner: fileData.extractedPartner,
          extractedIban: fileData.extractedIban,
          extractedText: fileData.extractedText,
          partnerId: fileData.partnerId,
          precisionSearchHint: fileData.precisionSearchHint,
        },
        {
          id: doc.id,
          amount: txData.amount,
          date: txData.date,
          currency: txData.currency,
          name: txData.name,
          partner: txData.partner,
          partnerName: txData.partnerName,
          partnerId: txData.partnerId,
          partnerIban: txData.partnerIban,
          reference: txData.reference,
        },
        partnerAliases,
        scoringOptions
      );
    });

  const matches = allScores
    .filter((m) => m.confidence >= CONFIG.SUGGESTION_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, CONFIG.MAX_SUGGESTIONS);

  // Helper to format score breakdown (using shared function)
  const formatBreakdown = (m: TransactionMatchScore) => formatScoreBreakdown(m.breakdown);

  // Log top matches with breakdown
  if (matches.length > 0) {
    console.log(`[TxMatch] Top ${matches.length} matches:`);
    for (const m of matches.slice(0, 5)) {
      const txAmount = (m.preview.amount / 100).toFixed(2);
      const txDate = m.preview.date.toDate().toISOString().split("T")[0];
      const breakdown = formatBreakdown(m);
      console.log(`[TxMatch]   ${m.confidence}% - "${m.preview.name}" | ${txAmount} ${m.preview.currency} | ${txDate}`);
      console.log(`[TxMatch]       Breakdown: ${breakdown}`);
    }
  } else {
    // Log best non-qualifying match for debugging
    const bestNonMatch = allScores.sort((a, b) => b.confidence - a.confidence)[0];
    if (bestNonMatch) {
      const txAmount = (bestNonMatch.preview.amount / 100).toFixed(2);
      const txDate = bestNonMatch.preview.date.toDate().toISOString().split("T")[0];
      const breakdown = formatBreakdown(bestNonMatch);
      console.log(`[TxMatch] No matches above ${CONFIG.SUGGESTION_THRESHOLD}%. Best was ${bestNonMatch.confidence}%:`);
      console.log(`[TxMatch]   "${bestNonMatch.preview.name}" | ${txAmount} ${bestNonMatch.preview.currency} | ${txDate}`);
      console.log(`[TxMatch]   Breakdown: ${breakdown}`);
    } else {
      console.log(`[TxMatch] No matches found.`);
    }
  }

  // In passive mode: store suggestions but skip auto-connecting and agentic workers
  const passive = await isPassiveMode(userId);
  if (passive) {
    console.log(`[TxMatch] Passive mode for user ${userId} — storing suggestions only, skipping auto-connect`);

    const suggestions: TransactionSuggestion[] = matches.map((m) => ({
      transactionId: m.transactionId,
      confidence: m.confidence,
      matchSources: m.matchSources,
      preview: m.preview,
    }));

    await db.collection("files").doc(fileId).update({
      transactionMatchComplete: true,
      transactionMatchedAt: Timestamp.now(),
      transactionSuggestions: suggestions,
      updatedAt: Timestamp.now(),
    });

    const elapsed = Date.now() - t0;
    console.log(
      `[TxMatch] Passive mode complete for ${fileData.fileName || fileId}: ` +
        `${suggestions.length} suggestions stored (${elapsed}ms)`
    );
    return;
  }

  // Separate auto-matches from suggestions
  let potentialAutoMatches = matches.filter((m) => m.confidence >= CONFIG.AUTO_MATCH_THRESHOLD);

  // Check partner's resolution preference - if partner strongly prefers no-receipt,
  // demote file matches to suggestions only (don't auto-connect)
  if (potentialAutoMatches.length > 0 && fileData.partnerId) {
    try {
      const partnerDoc = await db.collection("partners").doc(fileData.partnerId).get();
      if (partnerDoc.exists) {
        const partnerData = partnerDoc.data()!;
        const resolutionPref = partnerData.resolutionPreference;

        if (resolutionPref?.type === "no_receipt" && resolutionPref.confidence > 0) {
          const topFileMatch = potentialAutoMatches[0];
          // If partner's no-receipt preference is stronger than file match, demote
          if (resolutionPref.confidence >= topFileMatch.confidence) {
            console.log(
              `[TxMatch] Partner ${fileData.partnerId} prefers no-receipt ` +
              `(${resolutionPref.confidence}%) over file match (${topFileMatch.confidence}%) - ` +
              `demoting ${potentialAutoMatches.length} matches to suggestions`
            );
            potentialAutoMatches = []; // All become suggestions only
          }
        }
      }
    } catch (err) {
      console.warn("[TxMatch] Failed to check partner resolution preference:", err);
      // Continue with normal matching if preference check fails
    }
  }

  // Filter out auto-matches for transactions that are already "covered"
  // This prevents over-matching (e.g., 6 monthly invoices all matching one transaction)
  const autoMatches: typeof potentialAutoMatches = [];
  for (const match of potentialAutoMatches) {
    const isCovered = await isTransactionCovered(
      match.transactionId,
      match.preview.amount
    );
    if (isCovered) {
      console.log(
        `[TxMatch] Skipping auto-match for ${match.transactionId} (already covered by existing files)`
      );
    } else {
      autoMatches.push(match);
    }
  }

  // Build suggestions for storage (still show covered transactions as suggestions,
  // but mark them so UI can indicate they're already covered)
  const suggestions: TransactionSuggestion[] = matches.map((m) => ({
    transactionId: m.transactionId,
    confidence: m.confidence,
    matchSources: m.matchSources,
    preview: m.preview,
  }));

  const batch = db.batch();
  const fileRef = db.collection("files").doc(fileId);
  const newTransactionIds: string[] = [];

  // Create auto-connections (only for non-covered transactions)
  for (const match of autoMatches) {
    const connectionRef = db.collection("fileConnections").doc();
    batch.set(connectionRef, {
      fileId,
      transactionId: match.transactionId,
      userId,
      connectionType: "auto_matched",
      matchSources: match.matchSources,
      matchConfidence: match.confidence,
      scoreBreakdown: match.breakdown,
      createdAt: Timestamp.now(),
    });

    // Update transaction's fileIds array
    const txRef = db.collection("transactions").doc(match.transactionId);
    batch.update(txRef, {
      fileIds: FieldValue.arrayUnion(fileId),
      updatedAt: Timestamp.now(),
    });

    newTransactionIds.push(match.transactionId);

    // Learn email domain from Gmail files (non-blocking)
    learnEmailDomainFromMatch(fileData, match.transactionId).catch((err) => {
      console.error(`Failed to learn email domain for tx ${match.transactionId}:`, err);
    });

    // Handle partner resolution for auto-matched transactions
    const txDoc = await db.collection("transactions").doc(match.transactionId).get();
    if (txDoc.exists) {
      const txData = txDoc.data()!;
      const resolution = resolvePartnerConflict(
        fileData.partnerId || null,
        fileData.partnerMatchedBy || null,
        txData.partnerId || null,
        txData.partnerMatchedBy || null
      );

      // If file's partner should win and transaction doesn't have it, update transaction
      if (
        resolution.source === "file" &&
        fileData.partnerId &&
        txData.partnerId !== fileData.partnerId
      ) {
        batch.update(txRef, {
          partnerId: fileData.partnerId,
          partnerType: fileData.partnerType,
          partnerMatchedBy: "auto",
          partnerMatchConfidence: fileData.partnerMatchConfidence || null,
        });
      }
    }
  }

  // Update file document
  const fileUpdate: Record<string, unknown> = {
    transactionMatchComplete: true,
    transactionMatchedAt: Timestamp.now(),
    transactionSuggestions: suggestions,
    updatedAt: Timestamp.now(),
  };

  if (newTransactionIds.length > 0) {
    fileUpdate.transactionIds = FieldValue.arrayUnion(...newTransactionIds);
  }

  batch.update(fileRef, fileUpdate);

  await batch.commit();

  const elapsed = Date.now() - t0;
  console.log(
    `[TxMatch] Complete for ${fileData.fileName || fileId}: ` +
      `${autoMatches.length} auto-matched, ${suggestions.length} suggestions (${elapsed}ms)`
  );

  // Create notification with transcript if matches found
  if (autoMatches.length > 0 || suggestions.length > 0) {
    try {
      // Build synthetic transcript showing what the matching process did
      const transcript = buildMatchingTranscript(
        fileData,
        fileId,
        candidateCount,
        matches,
        autoMatches,
        suggestions,
        elapsed
      );

      await db.collection(`users/${userId}/notifications`).add({
        type: "worker_activity",
        title:
          autoMatches.length > 0
            ? `Matched file to ${autoMatches.length} transaction${autoMatches.length !== 1 ? "s" : ""}`
            : `Found ${suggestions.length} transaction suggestion${suggestions.length !== 1 ? "s" : ""}`,
        message:
          autoMatches.length > 0
            ? `${fileData.fileName || "Your file"} was automatically matched.`
            : `Found potential matches for ${fileData.fileName || "your file"}. Please review.`,
        createdAt: FieldValue.serverTimestamp(),
        readAt: null,
        context: {
          workerType: "file_matching",
          workerStatus: "completed",
          actionsPerformed: autoMatches.length,
          fileId,
        },
        transcript,
      });
    } catch (err) {
      console.error("Failed to create notification:", err);
    }
  }

  // Queue agentic follow-up:
  // - Partner batch: only on explicit "new successful match for this partner" signal
  // - No partner: keep legacy per-file fallback only when no auto-match
  const shouldQueuePartnerBatch = Boolean(fileData.partnerId) && newTransactionIds.length > 0;
  const shouldQueueSingleFileWorker = !fileData.partnerId && autoMatches.length === 0;

  if (shouldQueuePartnerBatch || shouldQueueSingleFileWorker) {
    // Check AI budget before queuing agentic workers (rule-based scoring above stays free)
    let isAdminUser = false;
    try {
      const userRecord = await getAuth().getUser(userId);
      isAdminUser = userRecord.customClaims?.admin === true;
    } catch { /* not found = not admin */ }
    const aiBudget = await checkAIBudget(userId, isAdminUser);

    if (!aiBudget.allowed) {
      console.log(
        `[TxMatch] AI budget exhausted for user ${userId}, skipping agentic worker for file ${fileId}`
      );
    } else {
      const topSuggestionConfidence = suggestions[0]?.confidence || 0;

      try {
        if (shouldQueuePartnerBatch) {
          await queueForPartnerBatch(userId, fileId, fileData, topSuggestionConfidence);
        } else {
          await queueAgenticTransactionSearch(userId, fileId, fileData, topSuggestionConfidence);
        }
      } catch (err) {
        console.error(`[TxMatch] Failed to queue agentic search for file ${fileId}:`, err);
      }
    }
  }
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const deduped = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) deduped.add(trimmed);
  }
  return Array.from(deduped);
}

function buildPartnerBatchPrompt(partnerName: string, partnerId: string, fileIds: string[]): string {
  const ids = normalizeStringArray(fileIds);
  const preview = ids.slice(0, 20).join(", ");
  const overflow = ids.length > 20 ? ` ... (+${ids.length - 20} more)` : "";
  return `Batch match ${ids.length} files for partner "${partnerName}" (${partnerId}). File IDs: ${preview}${overflow}`;
}

function pickNotBeforeAt(
  now: Timestamp,
  currentNextEligibleAt: Timestamp | null | undefined
): Timestamp {
  if (currentNextEligibleAt && currentNextEligibleAt.toMillis() > now.toMillis()) {
    return currentNextEligibleAt;
  }
  return Timestamp.fromMillis(now.toMillis() + PARTNER_BATCH_COOLDOWN_MS);
}

function maxTimestamp(
  a: Timestamp | null | undefined,
  b: Timestamp | null | undefined
): Timestamp | null {
  if (!a) return b || null;
  if (!b) return a;
  return a.toMillis() >= b.toMillis() ? a : b;
}

/**
 * Queue file into a partner-level batch worker request.
 * Multiple files for the same partner are coalesced into a single state machine:
 * idle -> pending -> processing, with rerunNeeded for new arrivals during processing.
 */
async function queueForPartnerBatch(
  userId: string,
  fileId: string,
  fileData: FirebaseFirestore.DocumentData,
  topConfidence: number
): Promise<void> {
  const partnerId = fileData.partnerId;
  if (!partnerId) return;

  // Skip for no-receipt partners with no suggestions
  if (topConfidence === 0) {
    try {
      const partnerDoc = await db.collection("partners").doc(partnerId).get();
      const resPref = partnerDoc?.data()?.resolutionPreference;
      if (resPref?.type === "no_receipt" && resPref.confidence > 70) {
        console.log(
          `[TxMatch] Skipping batch queue for file ${fileId}: ` +
          `partner ${partnerId} prefers no-receipt (${resPref.confidence}%)`
        );
        return;
      }
    } catch {
      // Continue if partner check fails
    }
  }

  const partnerDoc = await db.collection("partners").doc(partnerId).get();
  const partnerName = partnerDoc.exists ? (partnerDoc.data()!.name || partnerId) : partnerId;

  const stateRef = db.collection(`users/${userId}/partnerBatchStates`).doc(partnerId);
  const requestsCol = db.collection(`users/${userId}/workerRequests`);
  const now = Timestamp.now();
  let action = "noop";
  let requestId: string | null = null;

  await db.runTransaction(async (tx) => {
    const stateTxnSnap = await tx.get(stateRef);
    const state = stateTxnSnap.exists
      ? (stateTxnSnap.data() as Partial<PartnerBatchStateDoc>)
      : null;
    const nextEligibleAt = pickNotBeforeAt(now, state?.nextEligibleAt);

    const queued = normalizeStringArray(state?.queuedFileIds);
    const inflight = normalizeStringArray(state?.inflightFileIds);
    const alreadyTracked = new Set([...queued, ...inflight]);
    if (alreadyTracked.has(fileId)) {
      action = "already_tracked";
      return;
    }

    const createRequest = (fileIds: string[], notBeforeAt: Timestamp): string => {
      const reqRef = requestsCol.doc();
      tx.set(reqRef, {
        id: reqRef.id,
        workerType: "partner_file_batch",
        initialPrompt: buildPartnerBatchPrompt(partnerName, partnerId, fileIds),
        triggerContext: {
          fileIds,
          fileId: fileIds[0],
          partnerId,
          topSuggestionConfidence: topConfidence,
          triggeredAfterRuleBasedMatch: true,
        },
        triggeredBy: "auto",
        status: "pending",
        notBeforeAt,
        createdAt: now,
        updatedAt: now,
      });
      return reqRef.id;
    };

    if (!state) {
      const initialFileIds = [fileId];
      requestId = createRequest(initialFileIds, nextEligibleAt);
      tx.set(stateRef, {
        userId,
        partnerId,
        status: "pending",
        activeRequestId: requestId,
        activeRunId: null,
        queuedFileIds: initialFileIds,
        inflightFileIds: [],
        rerunNeeded: false,
        version: 1,
        lastCompletedAt: null,
        nextEligibleAt,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies PartnerBatchStateDoc);
      action = "created_initial";
      return;
    }

    if (state.status === "processing") {
      tx.set(stateRef, {
        queuedFileIds: FieldValue.arrayUnion(fileId),
        rerunNeeded: true,
        nextEligibleAt,
        updatedAt: now,
        version: FieldValue.increment(1),
      }, { merge: true });
      action = "queued_for_rerun";
      return;
    }

    if (state.status === "pending") {
      const nextQueued = Array.from(new Set([...queued, fileId]));
      let nextStateEligibleAt = nextEligibleAt;
      const activeRequestId = state.activeRequestId || null;
      let activeRequestIsPending = false;
      let activeRequestStatus: string | undefined;
      let activeRequestNotBeforeAt: Timestamp | null = null;

      if (activeRequestId) {
        const reqSnap = await tx.get(requestsCol.doc(activeRequestId));
        const reqData = reqSnap.exists ? reqSnap.data() : undefined;
        activeRequestStatus = reqData?.status;
        activeRequestIsPending = activeRequestStatus === "pending";
        const maybeNotBefore = reqData?.notBeforeAt;
        if (maybeNotBefore && typeof maybeNotBefore.toMillis === "function") {
          activeRequestNotBeforeAt = maybeNotBefore as Timestamp;
        }
      }

      if (activeRequestId && activeRequestIsPending) {
        const requestNotBeforeAt = maxTimestamp(
          maxTimestamp(activeRequestNotBeforeAt, state.nextEligibleAt),
          nextEligibleAt
        ) || nextEligibleAt;
        nextStateEligibleAt = requestNotBeforeAt;
        tx.update(requestsCol.doc(activeRequestId), {
          initialPrompt: buildPartnerBatchPrompt(partnerName, partnerId, nextQueued),
          "triggerContext.fileIds": nextQueued,
          "triggerContext.fileId": nextQueued[0],
          notBeforeAt: requestNotBeforeAt,
          updatedAt: now,
        });
        requestId = activeRequestId;
        action = "appended_pending";
      } else if (activeRequestId && activeRequestStatus === "processing") {
        // Request got claimed between snapshots; keep one active run and mark rerun.
        tx.set(stateRef, {
          status: "processing",
          queuedFileIds: FieldValue.arrayUnion(fileId),
          rerunNeeded: true,
          nextEligibleAt,
          updatedAt: now,
          version: FieldValue.increment(1),
        }, { merge: true });
        requestId = activeRequestId;
        action = "queued_while_processing";
        return;
      } else {
        requestId = createRequest(nextQueued, nextEligibleAt);
        action = "recreated_pending";
      }

      tx.set(stateRef, {
        status: "pending",
        activeRequestId: requestId,
        activeRunId: null,
        queuedFileIds: nextQueued,
        inflightFileIds: [],
        rerunNeeded: false,
        nextEligibleAt: nextStateEligibleAt,
        updatedAt: now,
        version: FieldValue.increment(1),
      }, { merge: true });
      return;
    }

    const nextQueued = Array.from(new Set([...queued, fileId]));
    requestId = createRequest(nextQueued, nextEligibleAt);
    tx.set(stateRef, {
      status: "pending",
      activeRequestId: requestId,
      activeRunId: null,
      queuedFileIds: nextQueued,
      inflightFileIds: [],
      rerunNeeded: false,
      nextEligibleAt,
      updatedAt: now,
      version: FieldValue.increment(1),
      userId,
      partnerId,
      createdAt: state.createdAt || now,
    }, { merge: true });
    action = "restarted_from_idle";
  });

  console.log(
    `[TxMatch] Partner batch state update for ${partnerId}: ${action}` +
      (requestId ? ` (request ${requestId})` : "")
  );
}

/**
 * Queue an agentic transaction search worker when rule-based matching is uncertain.
 * The agent can reason about currency conversion, search Gmail, and make smarter matches.
 */
async function queueAgenticTransactionSearch(
  userId: string,
  fileId: string,
  fileData: FirebaseFirestore.DocumentData,
  topSuggestionConfidence: number
): Promise<void> {
  // Build prompt with file info for the worker
  const fileInfo = {
    fileName: fileData.fileName || "Unknown",
    amount: fileData.extractedAmount,
    currency: fileData.extractedCurrency || "EUR",
    date: fileData.extractedDate?.toDate?.()?.toISOString?.()?.split("T")[0],
    partner: fileData.extractedPartner || fileData.partnerName,
  };

  const promptParts = [
    `Find matching transaction for file "${fileInfo.fileName}"`,
  ];

  if (topSuggestionConfidence > 0) {
    promptParts.push(`Rule-based matching found suggestions but no confident match (top: ${topSuggestionConfidence}%)`);
  } else {
    promptParts.push(`Rule-based matching found no suggestions - search broadly`);
  }

  if (fileInfo.amount) {
    const amountStr = (fileInfo.amount / 100).toFixed(2);
    promptParts.push(`Amount: ${amountStr} ${fileInfo.currency}`);

    // Hint about currency conversion if non-EUR
    if (fileInfo.currency !== "EUR") {
      promptParts.push(`Note: Amount is in ${fileInfo.currency}, bank transactions are in EUR - check exchange rates`);
    }
  }
  if (fileInfo.date) {
    promptParts.push(`Date: ${fileInfo.date}`);
  }
  if (fileInfo.partner) {
    promptParts.push(`Partner: ${fileInfo.partner}`);
  }

  const initialPrompt = promptParts.join(". ");

  // Create worker request for frontend/worker processor to pick up
  const requestRef = db.collection(`users/${userId}/workerRequests`).doc();
  await requestRef.set({
    id: requestRef.id,
    workerType: "file_matching",
    initialPrompt,
    triggerContext: {
      fileId,
      topSuggestionConfidence,
      triggeredAfterRuleBasedMatch: true,
    },
    triggeredBy: "auto",
    status: "pending",
    createdAt: Timestamp.now(),
  });

  console.log(
    `[TxMatch] Queued agentic search for file ${fileId} (worker request ${requestRef.id}, ` +
    `top suggestion: ${topSuggestionConfidence}%)`
  );
}

// === Helper: Check for manual transaction connections ===

async function hasManualTransactionConnections(fileId: string): Promise<boolean> {
  const manualConnections = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("connectionType", "==", "manual")
    .limit(1)
    .get();

  return !manualConnections.empty;
}

// === Helper: Check if transaction is already "covered" by existing files ===

/**
 * Checks if a transaction already has enough files matched to cover its amount.
 * This prevents over-matching (e.g., 6 files matched to a single transaction
 * when only 1 file should match).
 *
 * @param transactionId - Transaction to check
 * @param transactionAmount - Transaction amount in cents (absolute value)
 * @param tolerance - Percentage tolerance (default 10% - transaction is "covered" if
 *                   sum of file amounts is within 10% of transaction amount)
 * @returns true if transaction is covered and shouldn't receive more files
 */
async function isTransactionCovered(
  transactionId: string,
  transactionAmount: number,
  tolerance: number = 0.1
): Promise<boolean> {
  // Get existing file connections for this transaction
  const connectionsSnapshot = await db
    .collection("fileConnections")
    .where("transactionId", "==", transactionId)
    .get();

  if (connectionsSnapshot.empty) {
    return false; // No files connected, not covered
  }

  // Get the connected files to sum their amounts
  const fileIds = connectionsSnapshot.docs.map((doc) => doc.data().fileId);

  // Firestore 'in' queries have a limit of 30, batch if needed
  let totalFileAmount = 0;
  for (let i = 0; i < fileIds.length; i += 30) {
    const batch = fileIds.slice(i, i + 30);
    const filesSnapshot = await db
      .collection("files")
      .where("__name__", "in", batch)
      .get();

    for (const fileDoc of filesSnapshot.docs) {
      const fileData = fileDoc.data();
      if (fileData.extractedAmount != null) {
        totalFileAmount += Math.abs(fileData.extractedAmount);
      }
    }
  }

  const absTxAmount = Math.abs(transactionAmount);

  // Transaction is "covered" if file total is within tolerance of transaction amount
  // or exceeds it
  const coverageRatio = totalFileAmount / absTxAmount;
  const isCovered = coverageRatio >= (1 - tolerance);

  if (isCovered) {
    console.log(
      `[TxMatch] Transaction ${transactionId} is already covered: ` +
      `${(totalFileAmount / 100).toFixed(2)} / ${(absTxAmount / 100).toFixed(2)} ` +
      `(${(coverageRatio * 100).toFixed(0)}%)`
    );
  }

  return isCovered;
}

// === Firestore Trigger ===

/**
 * Triggered when a file document is updated.
 * Runs transaction matching:
 * 1. After partner matching completes (initial run)
 * 2. When partnerId changes (re-run to update match scores)
 */
export const matchFileTransactions = onDocumentUpdated(
  {
    document: "files/{fileId}",
    region: "europe-west1",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 5, // Limit concurrency to prevent queue overload
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const fileId = event.params.fileId;

    if (!before || !after) return;

    // Case 1: Partner matching just completed (initial run)
    const partnerMatchJustCompleted =
      !before.partnerMatchComplete &&
      after.partnerMatchComplete &&
      !after.extractionError;

    // Case 2: Partner ID changed (re-run)
    const partnerIdChanged =
      before.partnerId !== after.partnerId &&
      after.transactionMatchComplete === true; // Only re-run if already ran once

    // Case 3: Precision search requested re-matching (transactionMatchComplete flipped to false)
    const precisionSearchRequested =
      before.transactionMatchComplete === true &&
      after.transactionMatchComplete === false &&
      after.precisionSearchHint;

    // Determine if we should run
    let shouldRun = false;
    let reason = "";

    if (partnerMatchJustCompleted && !after.transactionMatchComplete) {
      shouldRun = true;
      reason = "partner_match_complete";
    } else if (precisionSearchRequested) {
      // Precision search added a hint and requested re-matching
      shouldRun = true;
      reason = "precision_search_hint";
    } else if (partnerIdChanged) {
      // Check for manual connections before re-running
      const hasManual = await hasManualTransactionConnections(fileId);
      if (!hasManual) {
        shouldRun = true;
        reason = "partner_changed";
        // Reset the file's transaction match state to trigger re-matching
        await db.collection("files").doc(fileId).update({
          transactionMatchComplete: false,
          transactionSuggestions: [],
          updatedAt: Timestamp.now(),
        });
        // Re-fetch the updated file data
        const updatedDoc = await db.collection("files").doc(fileId).get();
        if (updatedDoc.exists) {
          Object.assign(after, updatedDoc.data());
        }
      } else {
        console.log(`Skipping transaction re-matching for file ${fileId}: has manual connections`);
      }
    }

    if (!shouldRun) {
      return;
    }

    console.log(`Starting transaction matching for file: ${fileId} (reason: ${reason})`);

    try {
      await runTransactionMatching(fileId, after);
    } catch (error) {
      console.error(`Transaction matching failed for file ${fileId}:`, error);
      // Mark as complete with no matches (don't block the process)
      await db.collection("files").doc(fileId).update({
        transactionMatchComplete: true,
        transactionMatchedAt: Timestamp.now(),
        transactionSuggestions: [],
        updatedAt: Timestamp.now(),
      });
    }
  }
);
