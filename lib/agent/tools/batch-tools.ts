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

// Lazy-load admin DB to avoid initialization at build time
let _db: ReturnType<typeof import("@/lib/firebase/admin").getAdminDb> | null = null;
async function getDb() {
  if (!_db) {
    const { getAdminDb } = await import("@/lib/firebase/admin");
    _db = getAdminDb();
  }
  return _db;
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

    const transactions = txSnap.docs
      .filter((doc) => !doc.data().quotaExceeded)
      .map((doc) => {
        const data = doc.data();
        return {
          transactionId: doc.id,
          amount: data.amount,
          currency: data.currency || "EUR",
          date: data.date?.toDate?.()?.toISOString?.()?.split("T")[0],
          name: data.name,
          hasFiles: (data.fileIds?.length || 0) > 0,
          isComplete: data.isComplete,
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
      files,
      transactions,
      summary: `Loaded ${files.length} files and ${transactions.length} transactions for partner "${partnerData.name}"`,
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
      const result = await callFirebaseFunction<
        { query: string; maxResults: number },
        { attachments?: unknown[]; totalCount?: number }
      >(
        "searchGmailAttachments",
        {
          query: searchQuery,
          maxResults: 20,
        },
        authHeader
      );

      return {
        results: result?.attachments || [],
        totalCount: result?.totalCount || 0,
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
      .where("transactionIds", "==", []) // Unconnected files
      .limit(50)
      .get();

    const files = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        fileId: doc.id,
        fileName: data.fileName,
        extractedAmount: data.extractedAmount,
        extractedDate: data.extractedDate?.toDate?.()?.toISOString?.()?.split("T")[0],
        extractedPartner: data.extractedPartner,
      };
    });

    return {
      files,
      totalCount: files.length,
      query: searchQuery,
    };
  },
  {
    name: "searchLocalFilesForPartner",
    description:
      "Search local files for a partner. Finds unconnected files that belong to this partner.",
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

    // Score each pair via the server-side scoring callable
    const results = [];
    for (const pair of pairs) {
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

    // Compute optimal greedy assignment (highest confidence first, no duplicates)
    const assignedFiles = new Set<string>();
    const assignedTransactions = new Set<string>();
    const assignments = [];

    for (const r of results) {
      if (assignedFiles.has(r.fileId) || assignedTransactions.has(r.transactionId)) continue;
      if (r.confidence < 50) continue; // Skip low confidence
      assignedFiles.add(r.fileId);
      assignedTransactions.add(r.transactionId);
      assignments.push(r);
    }

    return {
      allScores: results,
      recommendedAssignments: assignments,
      summary: `Scored ${pairs.length} pairs. ${assignments.length} recommended assignments (≥50% confidence).`,
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

    const results = [];
    for (const conn of connections) {
      try {
        const result = await callFirebaseFunction<
          { fileId: string; transactionId: string; connectionType: string; matchConfidence: number },
          { connectionId?: string }
        >(
          "connectFileToTransaction",
          {
            fileId: conn.fileId,
            transactionId: conn.transactionId,
            connectionType: "auto_matched",
            matchConfidence: conn.confidence,
          },
          authHeader
        );
        results.push({
          fileId: conn.fileId,
          transactionId: conn.transactionId,
          success: true,
          connectionId: result?.connectionId,
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
      summary: `Connected ${successCount}/${connections.length} file-transaction pairs.`,
    };
  },
  {
    name: "bulkConnectFiles",
    description:
      "Batch connect multiple file-transaction pairs. Each connection is created via the standard connectFileToTransaction callable.",
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
