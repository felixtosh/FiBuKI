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

import { toDateSafe } from "../utils/toDateSafe";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  SCORING_CONFIG,
  formatScoreBreakdown,
  TransactionMatchScore,
} from "./transactionScoring";
import {
  autoConnect,
  ineligibleReasonOf,
  matchDatesKey,
  selectAutoConnects,
  storedSuggestionsOf,
  transactionsForFile,
  MATCH_WINDOW_DAYS,
  type StoredSuggestion,
} from "./matcher";
import { runCopyCheck } from "../files/copyOps";
import { readDismissedTransactionIds } from "./dismissedTransactions";
import { runCorrectionCheck } from "../corrections/correctionOps";
import { runReceiptPairCheck } from "../receiptPairs/receiptPairOps";
import { isHandCorrectionWrite } from "../fileFacts/factChange";
import { rescoreFileSuggestions } from "./rescoreFileSuggestions";
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
    dateRangeDays: MATCH_WINDOW_DAYS,
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

type TransactionSuggestion = StoredSuggestion;

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

/** Cap on dismissed ids spelled out in an agentic worker prompt. */
const MAX_DISMISSED_IN_PROMPT = 20;

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

// === Main Function ===

export interface TransactionMatchingOptions {
  /**
   * Transactions a precision-search strategy nominated for this run (#589).
   * Each is a candidate even outside the date window, and is scored like any
   * other: a nomination is worth nothing by itself.
   */
  nominatedTransactionIds?: string[];
}

export async function runTransactionMatching(
  fileId: string,
  fileData: FirebaseFirestore.DocumentData,
  options: TransactionMatchingOptions = {}
): Promise<void> {
  const markComplete = (suggestions: StoredSuggestion[]) =>
    db.collection("files").doc(fileId).update({
      transactionMatchComplete: true,
      transactionMatchedAt: Timestamp.now(),
      transactionSuggestions: suggestions,
      updatedAt: Timestamp.now(),
    });

  // A deleted File is left as it is: nothing to mark.
  const before = ineligibleReasonOf(fileData, false);
  if (before === "deleted") {
    console.log(`[TxMatch] Skipping deleted file: ${fileId}`);
    return;
  }

  // #162: the Copy check runs here, after Extraction and before scoring, so a
  // File it records as a Copy is never scored at all; one it only suggests is
  // matched as usual.
  if (before !== "not-invoice") {
    const copyCheck = await runCopyCheck(db, fileId, fileData).catch((err) => {
      console.error(`[TxMatch] Copy check failed for ${fileId}, matching as usual`, err);
      return { kind: "none" as const };
    });
    if (copyCheck.kind === "recorded-this") {
      console.log(`[TxMatch] File ${fileId} is a Copy of ${copyCheck.originalFileId}, skipping transaction matching`);
      await markComplete([]);
      return;
    }
  }

  const userId = fileData.userId;
  const t0 = Date.now();

  const fileAmount = fileData.extractedAmount != null ? (fileData.extractedAmount / 100).toFixed(2) : "N/A";
  const fileDate = toDateSafe(fileData.extractedDate)?.toISOString().slice(0, 10) ?? "N/A";
  console.log(`[TxMatch] File: ${fileData.fileName || fileId}`);
  console.log(`[TxMatch]   Amount: ${fileAmount} ${fileData.extractedCurrency || "EUR"}, Date: ${fileDate}`);
  console.log(`[TxMatch]   Extracted partner: "${fileData.extractedPartner || "none"}"`);
  console.log(`[TxMatch]   Assigned partnerId: ${fileData.partnerId || "none"}`);

  // Candidates, the date window, Rejections, over-quota Transactions and the
  // scores are the matcher's (#613), so what is stored here is what every
  // other surface ranks.
  const file = { id: fileId, data: fileData };
  const result = await transactionsForFile(db, userId, file, {
    nominatedTransactionIds: options.nominatedTransactionIds,
  });
  if (result.ineligible) {
    // A non-invoice, a Copy, or (#229) a document addressed to somebody else:
    // suggesting that against the User's bank lines is the step that puts its
    // VAT into the UVA as recoverable. Confirming the recipient reopens it.
    console.log(`[TxMatch] File ${fileId} is never matched (${result.ineligible}), skipping`);
    await markComplete([]);
    return;
  }

  if (result.windowSize === 0) {
    console.log(`[TxMatch] No transactions found, marking complete`);
    await markComplete([]);
    return;
  }

  const allScores = result.matches;
  const candidateCount = result.totalCandidates;
  console.log(`[TxMatch] Scored ${candidateCount} candidate transactions`);
  if (result.documentedAmounts.size > 0) {
    console.log(
      `[TxMatch] ${result.documentedAmounts.size} candidate(s) already hold files — scoring those against their remainder`
    );
  }

  const suggestions = storedSuggestionsOf(allScores);
  const matches = suggestions.map((s) => allScores.find((m) => m.transactionId === s.transactionId)!);

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
    const bestNonMatch = allScores[0];
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
    await markComplete(suggestions);
    const elapsed = Date.now() - t0;
    console.log(
      `[TxMatch] Passive mode complete for ${fileData.fileName || fileId}: ` +
        `${suggestions.length} suggestions stored (${elapsed}ms)`
    );
    return;
  }

  // The upload trigger's auto-connect rules, the matcher's (#613): the
  // threshold, Coverage, the same-day Remainder rule (#242, ADR-0008) and the
  // Partner's no-receipt preference. Written through the File Connection
  // writer (#612), which refuses what an automated connect may not do.
  const { picks, refusals } = await selectAutoConnects(db, userId, file, result);
  for (const r of refusals) {
    console.log(`[TxMatch] Suggestion only for ${r.transactionId} at ${r.confidence}% (${r.reason})`);
  }
  for (const pick of picks) {
    if (pick.autoConnectReason === "remainder_same_day") {
      console.log(
        `[TxMatch] Remainder auto-connect for ${pick.match.transactionId} at ${pick.match.confidence}% ` +
          "(closes the remainder, same day as the files already on it)"
      );
    } else if (pick.autoConnectReason === "paired") {
      console.log(
        `[TxMatch] Paired auto-connect for ${pick.match.transactionId} at ${pick.match.confidence}% ` +
          "(the other File of this File's Receipt Link is on it)"
      );
    } else if (pick.autoConnectReason === "instalment") {
      console.log(
        `[TxMatch] Instalment auto-connect for ${pick.match.transactionId} at ${pick.match.confidence}% ` +
          "(a printed instalment, or closes what the File has outstanding)"
      );
    }
  }
  const autoMatches = (await autoConnect(db, userId, fileId, picks)).map((p) => p.match);

  await markComplete(suggestions);

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
  // - No partner: keep legacy per-file fallback only when no auto-match, and
  //   not on a search's nomination run (#589): that run checks one pair, and
  //   a search nominates to several files per transaction. Not on a tie
  //   either (#667): the worker connects a strong suggestion itself, so it
  //   would pick one of the tied Transactions the rule leaves to the User.
  const tied = refusals.some((r) => r.tie);
  const shouldQueuePartnerBatch = Boolean(fileData.partnerId) && autoMatches.length > 0;
  const shouldQueueSingleFileWorker =
    !fileData.partnerId && autoMatches.length === 0 && !options.nominatedTransactionIds?.length && !tied;

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
    date: toDateSafe(fileData.extractedDate)?.toISOString?.()?.split("T")[0],
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

  // A dismissed pair is now filtered out of scoring, so a file whose only
  // strong candidate was dismissed reaches this worker looking unmatched. The
  // worker connects through connectFileToTransaction, which has no dismissal
  // check of its own — tell the agent what is off-limits, or it re-proposes
  // exactly what the user rejected.
  const dismissedIds = [...readDismissedTransactionIds(fileData)];
  if (dismissedIds.length > 0) {
    const listed = dismissedIds.slice(0, MAX_DISMISSED_IN_PROMPT);
    const more = dismissedIds.length - listed.length;
    promptParts.push(
      `Do NOT connect these transactions - the user already rejected them for this file: ` +
        listed.join(", ") +
        (more > 0 ? ` (and ${more} more)` : "")
    );
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
      dismissedTransactionIds: dismissedIds,
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

// === Helper: Re-score suggestions after a date edit (#614) ===

/**
 * A finished File whose File date, Due Date or Debit Date changed. Only
 * once matching has run and is not being re-run: extraction and a retry
 * write these dates while `transactionMatchComplete` is false, and that run
 * stores its own suggestions.
 */
function matchDatesEdited(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData
): boolean {
  return (
    before.transactionMatchComplete === true &&
    after.transactionMatchComplete === true &&
    !after.deletedAt &&
    matchDatesKey(before) !== matchDatesKey(after)
  );
}

// === Firestore Trigger ===

/**
 * Triggered when a file document is updated.
 * Runs transaction matching:
 * 1. After partner matching completes (initial run)
 * 2. When partnerId changes (re-run to update match scores)
 * And re-scores the stored suggestions, connecting nothing, when a hand edit
 * moves the File date, Due Date or Debit Date (#614).
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

    // #564: the correction check reads the Partner, the referenced invoice
    // number, the amount and the heading. It runs whenever one of them moves,
    // manual File Connections or not: a credit note is usually connected by
    // hand, and its link must still follow its Partner.
    const correctionInputsChanged =
      partnerMatchJustCompleted ||
      before.partnerId !== after.partnerId ||
      before.extractedReferencedInvoiceNumber !== after.extractedReferencedInvoiceNumber ||
      before.extractedAmount !== after.extractedAmount ||
      before.extractedSelfDesignation !== after.extractedSelfDesignation;
    if (correctionInputsChanged) {
      await runCorrectionCheck(db, fileId, after).catch((err) => {
        console.error(`[CorrectionCheck] Failed for ${fileId}`, err);
      });
    }

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
    } else if (matchDatesEdited(before, after) && !isHandCorrectionWrite(before, after)) {
      // #614: an edit of the File date, Due Date or Debit Date moves the
      // window and the date score, so the stored suggestions are re-scored
      // through the one re-scorer (suggestions only, skipped when the File
      // has a manual File Connection). A Hand Correction is skipped here:
      // the File facts module already re-scored it.
      console.log(`Re-scoring transaction suggestions for file ${fileId} (reason: dates_edited)`);
      await rescoreFileSuggestions(db, fileId).catch((err) => {
        console.error(`Suggestion re-score failed for file ${fileId}:`, err);
      });
    }

    if (shouldRun) {
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

    // #571: the pair check reads the numbers, the issuer, the Partner, the
    // amount, the day and the Document Type. It runs whenever one of them
    // moves, and on a restore. After matching, so the Copy check has had its
    // say on a second File of the same document first; on the File as it
    // stands now, so a Connection matching just made is seen. Not before
    // Partner matching completes: until then the Copy check has not run.
    // After a Hand Correction it only suggests: a correction records no link
    // and connects nothing, Receipt Links included (#638, Stefan 2026-10-04).
    if (after.partnerMatchComplete && pairInputsChanged(before, after, partnerMatchJustCompleted)) {
      const fresh = (await db.collection("files").doc(fileId).get()).data();
      if (fresh) {
        const suggestOnly = isHandCorrectionWrite(before, after);
        await runReceiptPairCheck(db, fileId, fresh, { suggestOnly }).catch((err) => {
          console.error(`[ReceiptPair] Check failed for ${fileId}`, err);
        });
      }
    }
  }
);

function pairInputsChanged(
  before: FirebaseFirestore.DocumentData,
  after: FirebaseFirestore.DocumentData,
  partnerMatchJustCompleted: boolean
): boolean {
  const day = (v: unknown) => toDateSafe(v)?.toISOString().slice(0, 10) ?? null;
  const issuer = (d: FirebaseFirestore.DocumentData) =>
    `${d.extractedIssuer?.vatId ?? ""}|${d.extractedIssuer?.name ?? ""}|${d.extractedPartner ?? ""}`;
  return (
    partnerMatchJustCompleted ||
    before.partnerId !== after.partnerId ||
    before.extractedInvoiceNumber !== after.extractedInvoiceNumber ||
    before.extractedPaidInvoiceNumber !== after.extractedPaidInvoiceNumber ||
    before.extractedAmount !== after.extractedAmount ||
    before.extractedTipAmount !== after.extractedTipAmount ||
    before.extractedCurrency !== after.extractedCurrency ||
    before.documentType !== after.documentType ||
    day(before.extractedDate) !== day(after.extractedDate) ||
    issuer(before) !== issuer(after) ||
    (!!before.deletedAt && !after.deletedAt)
  );
}
