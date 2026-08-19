/**
 * Batch Tools
 *
 * Tools for the partner_file_batch worker type.
 * These tools enable efficient batch processing of multiple files
 * for a single partner.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
// See the note on the same import in search-tools: one reader of the dismissal
// fields, not a per-call-site re-derivation.
import { readDismissedTransactionIds } from "../../../functions/src/matching/dismissedTransactions";

// Lazy-load admin DB to avoid initialization at build time
let _db: ReturnType<typeof import("@/lib/firebase/admin").getAdminDb> | null = null;
async function getDb() {
  if (!_db) {
    const { getAdminDb } = await import("@/lib/firebase/admin");
    _db = getAdminDb();
  }
  return _db;
}

/** Key for one file-to-transaction pair, matching scoreBatchMatches' score table. */
function pairKey(fileId: string, transactionId: string): string {
  return `${fileId}::${transactionId}`;
}

/**
 * Which of these pairs the file side currently rejects (fork #101).
 *
 * The partner batch is the path #94 could not reach: `queueForPartnerBatch`
 * aggregates many files into one prompt, so a per-file exclusion list does not
 * fit the prompt shape and the steer has to be a gate in the tools instead.
 *
 * One read per distinct file, not per pair — the batcher scores N files against
 * M transactions, so the pair list is the product while the file list is not.
 */
async function dismissedPairsAmong(
  pairs: Array<{ fileId: string; transactionId: string }>
): Promise<Set<string>> {
  const fileIds = [...new Set(pairs.map((p) => p.fileId).filter(Boolean))];
  if (fileIds.length === 0) return new Set<string>();

  const db = await getDb();
  const snaps = await Promise.all(
    fileIds.map((id) => db.collection("files").doc(id).get())
  );

  const dismissedByFile = new Map<string, Set<string>>();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    dismissedByFile.set(snap.id, readDismissedTransactionIds(snap.data()));
  }

  const dismissed = new Set<string>();
  for (const pair of pairs) {
    if (dismissedByFile.get(pair.fileId)?.has(pair.transactionId)) {
      dismissed.add(pairKey(pair.fileId, pair.transactionId));
    }
  }
  return dismissed;
}

// ============================================================================
// Assignment Helpers
// ============================================================================

function isAutoConnectionType(connectionType: unknown): boolean {
  return connectionType === "auto_matched" || connectionType === "ai_matched";
}

/**
 * Hungarian algorithm (min-cost assignment) for square matrices.
 * Returns an array where result[row] = assigned column.
 */
function hungarianMinCost(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];

  const u = Array(n + 1).fill(0);
  const v = Array(n + 1).fill(0);
  const p = Array(n + 1).fill(0);
  const way = Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(n + 1).fill(Infinity);
    const used = Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = Array(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) {
      assignment[p[j] - 1] = j - 1;
    }
  }
  return assignment;
}

// ============================================================================
// Load Partner Batch Context
// ============================================================================

export const loadPartnerBatchContextTool = tool(
  async ({ partnerId, fileIds }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) return { error: "User ID not provided" };

    const db = await getDb();

    // Load partner
    const partnerDoc = await db.collection("partners").doc(partnerId).get();
    if (!partnerDoc.exists || partnerDoc.data()!.userId !== userId) {
      return { error: "Partner not found" };
    }
    const partnerData = partnerDoc.data()!;

    // Load all batch files
    const files = [];
    for (let i = 0; i < fileIds.length; i += 30) {
      const batch = fileIds.slice(i, i + 30);
      const snap = await db
        .collection("files")
        .where("__name__", "in", batch)
        .get();
      for (const doc of snap.docs) {
        if (doc.data().userId !== userId) continue;
        const data = doc.data();
        files.push({
          fileId: doc.id,
          fileName: data.fileName,
          extractedAmount: data.extractedAmount,
          extractedCurrency: data.extractedCurrency,
          extractedDate: data.extractedDate?.toDate?.()?.toISOString?.()?.split("T")[0],
          extractedPartner: data.extractedPartner,
          topSuggestion: data.transactionSuggestions?.[0] || null,
          status: "pending",
        });
      }
    }

    // Load existing connection metadata for batch files (so the worker can reason
    // about occupied/locked items before proposing new matches).
    const batchFileIds = files.map((f) => f.fileId);
    const fileConnectionSummary = new Map<string, {
      total: number;
      auto: number;
      locked: number;
      transactionIds: string[];
    }>();
    for (let i = 0; i < batchFileIds.length; i += 30) {
      const batch = batchFileIds.slice(i, i + 30);
      if (batch.length === 0) continue;
      const snap = await db
        .collection("fileConnections")
        .where("userId", "==", userId)
        .where("fileId", "in", batch)
        .get();
      for (const doc of snap.docs) {
        const data = doc.data();
        const fId = data.fileId as string | undefined;
        const txId = data.transactionId as string | undefined;
        if (!fId || !txId) continue;
        const summary = fileConnectionSummary.get(fId) || {
          total: 0,
          auto: 0,
          locked: 0,
          transactionIds: [],
        };
        summary.total += 1;
        if (isAutoConnectionType(data.connectionType)) {
          summary.auto += 1;
        } else {
          summary.locked += 1;
        }
        if (!summary.transactionIds.includes(txId)) {
          summary.transactionIds.push(txId);
        }
        fileConnectionSummary.set(fId, summary);
      }
    }

    // Load candidate transactions for this partner (recent + date range from files)
    const fileDates = files
      .map((f) => f.extractedDate)
      .filter(Boolean)
      .map((d) => new Date(d!));

    let startDate: Date;
    let endDate: Date;

    if (fileDates.length > 0) {
      const earliest = new Date(Math.min(...fileDates.map((d) => d.getTime())));
      const latest = new Date(Math.max(...fileDates.map((d) => d.getTime())));
      startDate = new Date(earliest);
      startDate.setDate(startDate.getDate() - 45); // Wider range for batch
      endDate = new Date(latest);
      endDate.setDate(endDate.getDate() + 45);
    } else {
      endDate = new Date();
      startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 6);
    }

    const txSnap = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("partnerId", "==", partnerId)
      .where("date", ">=", Timestamp.fromDate(startDate))
      .where("date", "<=", Timestamp.fromDate(endDate))
      .orderBy("date", "desc")
      .limit(200)
      .get();

    const txIds = txSnap.docs.filter((doc) => !doc.data().quotaExceeded).map((doc) => doc.id);
    const txConnectionSummary = new Map<string, {
      total: number;
      auto: number;
      locked: number;
      fileIds: string[];
    }>();
    for (let i = 0; i < txIds.length; i += 30) {
      const batch = txIds.slice(i, i + 30);
      if (batch.length === 0) continue;
      const snap = await db
        .collection("fileConnections")
        .where("userId", "==", userId)
        .where("transactionId", "in", batch)
        .get();
      for (const doc of snap.docs) {
        const data = doc.data();
        const txId = data.transactionId as string | undefined;
        const fId = data.fileId as string | undefined;
        if (!txId || !fId) continue;
        const summary = txConnectionSummary.get(txId) || {
          total: 0,
          auto: 0,
          locked: 0,
          fileIds: [],
        };
        summary.total += 1;
        if (isAutoConnectionType(data.connectionType)) {
          summary.auto += 1;
        } else {
          summary.locked += 1;
        }
        if (!summary.fileIds.includes(fId)) {
          summary.fileIds.push(fId);
        }
        txConnectionSummary.set(txId, summary);
      }
    }

    const transactions = txSnap.docs
      .filter((doc) => !doc.data().quotaExceeded)
      .map((doc) => {
        const data = doc.data();
        const conn = txConnectionSummary.get(doc.id);
        return {
          transactionId: doc.id,
          amount: data.amount,
          currency: data.currency || "EUR",
          date: data.date?.toDate?.()?.toISOString?.()?.split("T")[0],
          name: data.name,
          hasFiles: (data.fileIds?.length || 0) > 0,
          isComplete: data.isComplete,
          connectedFileIds: data.fileIds || [],
          autoConnectionCount: conn?.auto || 0,
          lockedConnectionCount: conn?.locked || 0,
          hasLockedConnection: (conn?.locked || 0) > 0,
        };
      });

    const filesWithConnectionMeta = files.map((file) => {
      const conn = fileConnectionSummary.get(file.fileId);
      return {
        ...file,
        connectedTransactionIds: conn?.transactionIds || [],
        autoConnectionCount: conn?.auto || 0,
        lockedConnectionCount: conn?.locked || 0,
        hasLockedConnection: (conn?.locked || 0) > 0,
      };
    });

    return {
      partner: {
        id: partnerId,
        name: partnerData.name,
        aliases: partnerData.aliases || [],
        emailDomains: partnerData.emailDomains || [],
        fileSourcePatterns: partnerData.fileSourcePatterns || [],
        billingCycle: partnerData.billingCycle || null,
        scoringWeights: partnerData.scoringWeights || null,
        learnedPatterns: (partnerData.learnedPatterns || []).map(
          (p: { pattern: string; confidence: number }) => ({
            pattern: p.pattern,
            confidence: p.confidence,
          })
        ),
      },
      files: filesWithConnectionMeta,
      transactions,
      summary:
        `Loaded ${filesWithConnectionMeta.length} files and ${transactions.length} transactions for partner "${partnerData.name}". ` +
        `Includes current auto/manual occupancy so better matches can safely replace auto links.`,
    };
  },
  {
    name: "loadPartnerBatchContext",
    description:
      "Load all context for a partner batch: partner data, all batch files, and candidate transactions. Call this first to understand the full picture.",
    schema: z.object({
      partnerId: z.string().describe("The partner ID"),
      fileIds: z.array(z.string()).describe("Array of file IDs in the batch"),
    }),
  }
);

// ============================================================================
// Search Gmail for Partner
// ============================================================================

export const searchGmailForPartnerTool = tool(
  async ({ partnerId, searchQuery }, config) => {
    const userId = config?.configurable?.userId;
    const authHeader = config?.configurable?.authHeader;
    if (!userId || !authHeader) return { error: "Auth not provided" };

    try {
      const db = await getDb();

      // Look up user's active Gmail integrations
      const integrationsSnapshot = await db
        .collection("emailIntegrations")
        .where("userId", "==", userId)
        .where("provider", "==", "gmail")
        .where("isActive", "==", true)
        .get();

      if (integrationsSnapshot.empty) {
        return {
          error: "Gmail is not connected. Connect Gmail to search email attachments.",
          results: [],
          totalCount: 0,
          query: searchQuery,
        };
      }

      const allMessages: Array<{
        messageId: string;
        subject: string;
        from: string;
        date: string;
        snippet: string;
        attachments: Array<{ filename: string; mimeType: string; size: number }>;
      }> = [];

      for (const integrationDoc of integrationsSnapshot.docs) {
        const searchResponse = await callFirebaseFunction<
          { integrationId: string; query: string; hasAttachments: boolean; expandThreads: boolean; limit: number },
          { messages?: Array<{ messageId: string; subject: string; from: string; date: string; snippet: string; attachments?: Array<{ filename: string; mimeType: string; size: number }> }> }
        >(
          "searchGmailCallable",
          {
            integrationId: integrationDoc.id,
            query: searchQuery,
            hasAttachments: false,
            expandThreads: true,
            limit: 50,
          },
          authHeader
        );

        const messages = searchResponse?.messages || [];
        for (const msg of messages) {
          allMessages.push({
            messageId: msg.messageId,
            subject: msg.subject,
            from: msg.from,
            date: msg.date,
            snippet: msg.snippet,
            attachments: msg.attachments || [],
          });
        }
      }

      return {
        results: allMessages,
        totalCount: allMessages.length,
        query: searchQuery,
      };
    } catch (err) {
      return { error: `Gmail search failed: ${(err as Error).message}` };
    }
  },
  {
    name: "searchGmailForPartner",
    description:
      "Search Gmail for attachments from a partner. Uses the partner's known email domains and patterns. Results are shared across all batch items.",
    schema: z.object({
      partnerId: z.string().describe("The partner ID"),
      searchQuery: z.string().describe("Gmail search query (e.g., 'from:amazon.de has:attachment')"),
    }),
  }
);

// ============================================================================
// Search Local Files for Partner
// ============================================================================

export const searchLocalFilesForPartnerTool = tool(
  async ({ partnerId, searchQuery }, config) => {
    const userId = config?.configurable?.userId;
    if (!userId) return { error: "User ID not provided" };

    const db = await getDb();

    // Search files by partner ID
    const snap = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", partnerId)
      .where("extractionComplete", "==", true)
      .limit(100)
      .get();

    const fileIds = snap.docs.map((doc) => doc.id);
    const fileConnectionSummary = new Map<string, {
      auto: number;
      locked: number;
      transactionIds: string[];
    }>();

    for (let i = 0; i < fileIds.length; i += 30) {
      const batch = fileIds.slice(i, i + 30);
      if (batch.length === 0) continue;
      const connSnap = await db
        .collection("fileConnections")
        .where("userId", "==", userId)
        .where("fileId", "in", batch)
        .get();
      for (const connDoc of connSnap.docs) {
        const data = connDoc.data();
        const fileId = data.fileId as string | undefined;
        const transactionId = data.transactionId as string | undefined;
        if (!fileId || !transactionId) continue;
        const summary = fileConnectionSummary.get(fileId) || {
          auto: 0,
          locked: 0,
          transactionIds: [],
        };
        if (isAutoConnectionType(data.connectionType)) {
          summary.auto += 1;
        } else {
          summary.locked += 1;
        }
        if (!summary.transactionIds.includes(transactionId)) {
          summary.transactionIds.push(transactionId);
        }
        fileConnectionSummary.set(fileId, summary);
      }
    }

    const files = snap.docs.map((doc) => {
      const data = doc.data();
      const conn = fileConnectionSummary.get(doc.id);
      return {
        fileId: doc.id,
        fileName: data.fileName,
        extractedAmount: data.extractedAmount,
        extractedDate: data.extractedDate?.toDate?.()?.toISOString?.()?.split("T")[0],
        extractedPartner: data.extractedPartner,
        connectedTransactionIds: conn?.transactionIds || data.transactionIds || [],
        autoConnectionCount: conn?.auto || 0,
        lockedConnectionCount: conn?.locked || 0,
        hasLockedConnection: (conn?.locked || 0) > 0,
      };
    });

    return {
      files,
      totalCount: files.length,
      query: searchQuery,
      includesConnected: true,
    };
  },
  {
    name: "searchLocalFilesForPartner",
    description:
      "Search local files for a partner. Includes currently connected files and lock metadata so the batcher can safely rebalance auto matches.",
    schema: z.object({
      partnerId: z.string().describe("The partner ID"),
      searchQuery: z.string().describe("Description of what you're looking for"),
    }),
  }
);

// ============================================================================
// Score Batch Matches (NxM matrix)
// ============================================================================

export const scoreBatchMatchesTool = tool(
  async ({ pairs }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) return { error: "Auth not provided" };

    // Drop pairs the file side has rejected before spending a scoring call on
    // them (fork #101). A dismissed pair that reaches the matrix is worse than
    // wasted work: the Hungarian assignment can hand it the optimal slot, and
    // it arrives at bulkConnectFiles as a recommendation.
    const dismissedPairs = await dismissedPairsAmong(pairs);
    const scorablePairs = pairs.filter(
      (p) => !dismissedPairs.has(pairKey(p.fileId, p.transactionId))
    );

    // Score each pair via the server-side scoring callable
    const results = [];
    for (const pair of scorablePairs) {
      try {
        const result = await callFirebaseFunction<
          { fileId: string; transactionId: string },
          { confidence?: number; breakdown?: unknown }
        >(
          "scoreAttachmentMatch",
          {
            fileId: pair.fileId,
            transactionId: pair.transactionId,
          },
          authHeader
        );
        results.push({
          fileId: pair.fileId,
          transactionId: pair.transactionId,
          confidence: result?.confidence || 0,
          breakdown: result?.breakdown || null,
        });
      } catch (err) {
        results.push({
          fileId: pair.fileId,
          transactionId: pair.transactionId,
          confidence: 0,
          error: (err as Error).message,
        });
      }
    }

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);

    // Compute globally optimal one-to-one assignment (max total confidence)
    const fileIds = Array.from(new Set(results.map((r) => r.fileId)));
    const txIds = Array.from(new Set(results.map((r) => r.transactionId)));

    // Build dense score table (missing pairs treated as 0 confidence)
    const scoreByPair = new Map<string, number>();
    for (const r of results) {
      const key = `${r.fileId}::${r.transactionId}`;
      const existing = scoreByPair.get(key) || 0;
      if (r.confidence > existing) {
        scoreByPair.set(key, r.confidence);
      }
    }

    const matrixSize = Math.max(fileIds.length, txIds.length);
    const maxConfidence = results.length > 0
      ? Math.max(...results.map((r) => r.confidence), 0)
      : 0;

    const cost: number[][] = Array.from({ length: matrixSize }, (_, row) =>
      Array.from({ length: matrixSize }, (_, col) => {
        if (row >= fileIds.length || col >= txIds.length) {
          // Dummy file/transaction node, equivalent to "leave unmatched" with 0 confidence
          return maxConfidence;
        }
        const score = scoreByPair.get(`${fileIds[row]}::${txIds[col]}`) || 0;
        // Convert max-score objective to min-cost objective
        return maxConfidence - score;
      })
    );

    const rowToCol = hungarianMinCost(cost);
    const assignments: Array<{
      fileId: string;
      transactionId: string;
      confidence: number;
      breakdown?: unknown;
      error?: string;
    }> = [];

    for (let row = 0; row < rowToCol.length; row++) {
      const col = rowToCol[row];
      if (row >= fileIds.length || col < 0 || col >= txIds.length) continue;
      const fileId = fileIds[row];
      const transactionId = txIds[col];
      const confidence = scoreByPair.get(`${fileId}::${transactionId}`) || 0;
      if (confidence < 50) continue;

      const full = results.find((r) => r.fileId === fileId && r.transactionId === transactionId);
      assignments.push({
        fileId,
        transactionId,
        confidence,
        breakdown: full?.breakdown || null,
        error: full?.error,
      });
    }

    assignments.sort((a, b) => b.confidence - a.confidence);

    return {
      allScores: results,
      recommendedAssignments: assignments,
      dismissedPairsSkipped: dismissedPairs.size,
      summary:
        `Scored ${scorablePairs.length} pairs. ` +
        `${assignments.length} recommended assignments (optimal one-to-one, ≥50% confidence).` +
        (dismissedPairs.size > 0
          ? ` ${dismissedPairs.size} pair${dismissedPairs.size === 1 ? " was" : "s were"} previously rejected and ${dismissedPairs.size === 1 ? "was" : "were"} not scored — do not propose ${dismissedPairs.size === 1 ? "it" : "them"} again.`
          : ""),
    };
  },
  {
    name: "scoreBatchMatches",
    description:
      "Score multiple file-transaction pairs and compute optimal assignment. Returns an NxM scoring matrix with recommended assignments.",
    schema: z.object({
      pairs: z.array(
        z.object({
          fileId: z.string(),
          transactionId: z.string(),
        })
      ).describe("Array of file-transaction pairs to score"),
    }),
  }
);

// ============================================================================
// Bulk Connect Files
// ============================================================================

export const bulkConnectFilesTool = tool(
  async ({ connections }, config) => {
    const authHeader = config?.configurable?.authHeader;
    if (!authHeader) return { error: "Auth not provided" };

    const dedupedConnections = [...connections]
      .sort((a, b) => b.confidence - a.confidence)
      .filter((conn, index, arr) => {
        return arr.findIndex((candidate) =>
          candidate.fileId === conn.fileId || candidate.transactionId === conn.transactionId
        ) === index;
      });

    // The last gate before the write (fork #101). scoreBatchMatches already
    // drops dismissed pairs, but this tool takes whatever list the model hands
    // it — including one assembled from an earlier turn, or from a search
    // result that predates the rejection. A gate that only exists upstream of
    // the model is a suggestion.
    const dismissedPairs = await dismissedPairsAmong(dedupedConnections);

    const results = [];
    let reassignedConnections = 0;
    for (const conn of dedupedConnections) {
      if (dismissedPairs.has(pairKey(conn.fileId, conn.transactionId))) {
        results.push({
          fileId: conn.fileId,
          transactionId: conn.transactionId,
          success: false,
          error:
            "PAIR_REJECTED: this file was rejected for this transaction. Do not retry it. " +
            "Undo the rejection first (undismiss_transaction_suggestion) if connecting it is genuinely intended.",
        });
        continue;
      }
      try {
        const result = await callFirebaseFunction<
          {
            fileId: string;
            transactionId: string;
            connectionType: string;
            matchConfidence: number;
            allowAutoReassign: boolean;
          },
          { connectionId?: string; reassignedConnections?: number }
        >(
          "connectFileToTransaction",
          {
            fileId: conn.fileId,
            transactionId: conn.transactionId,
            connectionType: "auto_matched",
            matchConfidence: conn.confidence,
            allowAutoReassign: true,
          },
          authHeader
        );
        reassignedConnections += result?.reassignedConnections || 0;
        results.push({
          fileId: conn.fileId,
          transactionId: conn.transactionId,
          success: true,
          connectionId: result?.connectionId,
          reassignedConnections: result?.reassignedConnections || 0,
        });
      } catch (err) {
        results.push({
          fileId: conn.fileId,
          transactionId: conn.transactionId,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return {
      results,
      dismissedPairsRefused: dismissedPairs.size,
      summary:
        `Connected ${successCount}/${dedupedConnections.length} file-transaction pairs` +
        (reassignedConnections > 0
          ? ` and reassigned ${reassignedConnections} prior auto match${reassignedConnections === 1 ? "" : "es"}.`
          : ".") +
        (dismissedPairs.size > 0
          ? ` ${dismissedPairs.size} pair${dismissedPairs.size === 1 ? " was" : "s were"} refused as previously rejected — do not retry ${dismissedPairs.size === 1 ? "it" : "them"}.`
          : ""),
    };
  },
  {
    name: "bulkConnectFiles",
    description:
      "Batch connect multiple file-transaction pairs. Each connection is created via the standard connectFileToTransaction callable. A pair the file has previously rejected is refused with PAIR_REJECTED and is not retryable.",
    schema: z.object({
      connections: z.array(
        z.object({
          fileId: z.string(),
          transactionId: z.string(),
          confidence: z.number().describe("Match confidence 0-100"),
        })
      ).describe("Array of connections to create"),
    }),
  }
);

// ============================================================================
// Update Batch Task List
// ============================================================================

export const updateBatchTaskListTool = tool(
  async ({ updates }) => {
    // This tool is stateful - it just returns the updates for the LLM to track
    // The actual state management happens in the graph's context compacting
    return {
      updated: updates.length,
      items: updates,
    };
  },
  {
    name: "updateBatchTaskList",
    description:
      "Track progress on batch items. Mark files as matched, failed, or skipped with reasons.",
    schema: z.object({
      updates: z.array(
        z.object({
          fileId: z.string(),
          status: z.enum(["matched", "failed", "skipped"]),
          matchedTransactionId: z.string().optional(),
          reason: z.string().optional(),
        })
      ),
    }),
  }
);

// ============================================================================
// Export
// ============================================================================

export const BATCH_TOOLS = [
  loadPartnerBatchContextTool,
  searchGmailForPartnerTool,
  searchLocalFilesForPartnerTool,
  scoreBatchMatchesTool,
  bulkConnectFilesTool,
  updateBatchTaskListTool,
];
