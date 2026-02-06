/**
 * Export match intelligence data for analysis.
 *
 * Produces a structured report from existing data:
 * - All fileConnections (manual + auto + suggestion_accepted)
 * - Per-partner accuracy breakdown
 * - Missed suggestions (manual connections that weren't suggested)
 * - Rejection history (files rejected from transactions)
 * - Dismissal history (suggestions dismissed by user)
 *
 * Used to study match quality and discover improvement opportunities.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";

interface ExportMatchIntelligenceRequest {
  /** Filter to a specific partner (optional) */
  partnerId?: string;
  /** Max connections to export (default 500) */
  limit?: number;
}

interface ConnectionRecord {
  connectionId: string;
  fileId: string;
  transactionId: string;
  connectionType: string;
  matchConfidence: number | null;
  scoreBreakdown: Record<string, number> | null;
  wasSuggested: boolean;
  suggestedConfidence: number | null;
  suggestedRank: number | null;
  sourceType: string | null;
  createdAt: string;
  // Enriched from file/transaction
  fileName: string | null;
  extractedAmount: number | null;
  extractedPartner: string | null;
  transactionName: string | null;
  transactionAmount: number | null;
  transactionDate: string | null;
  partnerId: string | null;
  partnerName: string | null;
}

interface RejectionRecord {
  transactionId: string;
  fileId: string;
  rejectedAt: string | null;
  matchConfidence: number | null;
}

interface DismissalRecord {
  fileId: string;
  transactionId: string;
  dismissedAt: string | null;
  confidence: number | null;
}

interface PartnerSummary {
  partnerId: string;
  partnerName: string;
  totalConnections: number;
  manualCount: number;
  autoCount: number;
  suggestionAcceptedCount: number;
  missedSuggestions: number;
  rejections: number;
  accuracy: number;
}

interface MatchIntelligenceReport {
  connections: ConnectionRecord[];
  rejections: RejectionRecord[];
  dismissals: DismissalRecord[];
  partnerSummaries: PartnerSummary[];
  totals: {
    totalConnections: number;
    manualConnections: number;
    autoConnections: number;
    suggestionAccepted: number;
    totalRejections: number;
    totalDismissals: number;
    missedSuggestions: number;
    autoMatchAccuracy: number;
    suggestionAcceptRate: number;
  };
  exportedAt: string;
}

interface ExportMatchIntelligenceResponse {
  success: boolean;
  report: MatchIntelligenceReport;
}

export const exportMatchIntelligenceCallable = createCallable<
  ExportMatchIntelligenceRequest,
  ExportMatchIntelligenceResponse
>(
  { name: "exportMatchIntelligence" },
  async (ctx, request) => {
    const { partnerId, limit = 500 } = request;

    // 1. Load all fileConnections
    let connQuery = ctx.db
      .collection("fileConnections")
      .where("userId", "==", ctx.userId)
      .orderBy("createdAt", "desc")
      .limit(limit);

    const connSnap = await connQuery.get();

    // 2. Collect all file/transaction IDs for enrichment
    const fileIds = new Set<string>();
    const txIds = new Set<string>();
    for (const doc of connSnap.docs) {
      const d = doc.data();
      fileIds.add(d.fileId);
      txIds.add(d.transactionId);
    }

    // 3. Batch-load files and transactions for enrichment
    const fileMap = new Map<string, Record<string, unknown>>();
    const fileIdArr = [...fileIds];
    for (let i = 0; i < fileIdArr.length; i += 30) {
      const batch = fileIdArr.slice(i, i + 30);
      const snap = await ctx.db
        .collection("files")
        .where("__name__", "in", batch)
        .get();
      for (const doc of snap.docs) {
        fileMap.set(doc.id, doc.data());
      }
    }

    const txMap = new Map<string, Record<string, unknown>>();
    const txIdArr = [...txIds];
    for (let i = 0; i < txIdArr.length; i += 30) {
      const batch = txIdArr.slice(i, i + 30);
      const snap = await ctx.db
        .collection("transactions")
        .where("__name__", "in", batch)
        .get();
      for (const doc of snap.docs) {
        txMap.set(doc.id, doc.data());
      }
    }

    // 4. Load partners for name enrichment
    const partnerIds = new Set<string>();
    for (const f of fileMap.values()) {
      if (f.partnerId) partnerIds.add(f.partnerId as string);
    }
    for (const t of txMap.values()) {
      if (t.partnerId) partnerIds.add(t.partnerId as string);
    }

    const partnerMap = new Map<string, string>();
    const partnerIdArr = [...partnerIds];
    for (let i = 0; i < partnerIdArr.length; i += 30) {
      const batch = partnerIdArr.slice(i, i + 30);
      const snap = await ctx.db
        .collection("partners")
        .where("__name__", "in", batch)
        .get();
      for (const doc of snap.docs) {
        partnerMap.set(doc.id, doc.data().name || doc.id);
      }
    }

    // 5. Build rejection set for accuracy calculation
    const rejectedPairs = new Set<string>(); // "fileId:txId"
    const rejections: RejectionRecord[] = [];

    for (const [txId, txData] of txMap) {
      // New format
      for (const r of (txData.rejectedFiles || []) as Array<{
        fileId: string;
        rejectedAt?: Timestamp;
        matchConfidence?: number;
      }>) {
        rejectedPairs.add(`${r.fileId}:${txId}`);
        rejections.push({
          transactionId: txId,
          fileId: r.fileId,
          rejectedAt: r.rejectedAt ? (r.rejectedAt as Timestamp).toDate().toISOString() : null,
          matchConfidence: r.matchConfidence ?? null,
        });
      }
      // Legacy format
      for (const fId of (txData.rejectedFileIds || []) as string[]) {
        const key = `${fId}:${txId}`;
        if (!rejectedPairs.has(key)) {
          rejectedPairs.add(key);
          rejections.push({
            transactionId: txId,
            fileId: fId,
            rejectedAt: null,
            matchConfidence: null,
          });
        }
      }
    }

    // 6. Build dismissal list
    const dismissals: DismissalRecord[] = [];
    for (const [fileId, fileData] of fileMap) {
      // New format
      for (const d of (fileData.dismissedTransactions || []) as Array<{
        transactionId: string;
        dismissedAt?: Timestamp;
        confidence?: number;
      }>) {
        dismissals.push({
          fileId,
          transactionId: d.transactionId,
          dismissedAt: d.dismissedAt
            ? (d.dismissedAt as Timestamp).toDate().toISOString()
            : null,
          confidence: d.confidence ?? null,
        });
      }
      // Legacy format
      for (const txId of (fileData.dismissedTransactionIds || []) as string[]) {
        if (
          !dismissals.some(
            (d) => d.fileId === fileId && d.transactionId === txId
          )
        ) {
          dismissals.push({
            fileId,
            transactionId: txId,
            dismissedAt: null,
            confidence: null,
          });
        }
      }
    }

    // 7. Build enriched connection records
    const connections: ConnectionRecord[] = [];
    const perPartner = new Map<
      string,
      {
        total: number;
        manual: number;
        auto: number;
        suggestionAccepted: number;
        missed: number;
        rejected: number;
      }
    >();

    let totalManual = 0;
    let totalAuto = 0;
    let totalSuggestionAccepted = 0;
    let totalMissed = 0;
    let autoCorrect = 0;

    for (const doc of connSnap.docs) {
      const conn = doc.data();
      const fileData = fileMap.get(conn.fileId) || {};
      const txData = txMap.get(conn.transactionId) || {};
      const pId =
        (conn.partnerId as string) ||
        (fileData.partnerId as string) ||
        (txData.partnerId as string) ||
        null;

      // Filter by partner if requested
      if (partnerId && pId !== partnerId) continue;

      const connType = (conn.connectionType as string) || "manual";
      const pairKey = `${conn.fileId}:${conn.transactionId}`;
      const wasRejected = rejectedPairs.has(pairKey);

      const record: ConnectionRecord = {
        connectionId: doc.id,
        fileId: conn.fileId,
        transactionId: conn.transactionId,
        connectionType: connType,
        matchConfidence: conn.matchConfidence ?? null,
        scoreBreakdown: conn.scoreBreakdown ?? null,
        wasSuggested: conn.wasSuggested ?? false,
        suggestedConfidence: conn.suggestedConfidence ?? null,
        suggestedRank: conn.suggestedRank ?? null,
        sourceType: conn.sourceType ?? null,
        createdAt: conn.createdAt
          ? (conn.createdAt as Timestamp).toDate().toISOString()
          : "",
        fileName: (fileData.fileName as string) ?? null,
        extractedAmount: (fileData.extractedAmount as number) ?? null,
        extractedPartner: (fileData.extractedPartner as string) ?? null,
        transactionName: (txData.name as string) ?? null,
        transactionAmount: (txData.amount as number) ?? null,
        transactionDate: txData.date
          ? (txData.date as Timestamp).toDate().toISOString().split("T")[0]
          : null,
        partnerId: pId,
        partnerName: pId ? partnerMap.get(pId) || pId : null,
      };

      connections.push(record);

      // Track stats
      if (connType === "manual") {
        totalManual++;
        if (!conn.wasSuggested) totalMissed++;
      } else if (connType === "auto_matched") {
        totalAuto++;
        if (!wasRejected) autoCorrect++;
      } else if (connType === "suggestion_accepted") {
        totalSuggestionAccepted++;
      }

      // Per-partner stats
      if (pId) {
        if (!perPartner.has(pId)) {
          perPartner.set(pId, {
            total: 0,
            manual: 0,
            auto: 0,
            suggestionAccepted: 0,
            missed: 0,
            rejected: 0,
          });
        }
        const ps = perPartner.get(pId)!;
        ps.total++;
        if (connType === "manual") {
          ps.manual++;
          if (!conn.wasSuggested) ps.missed++;
        } else if (connType === "auto_matched") {
          ps.auto++;
          if (wasRejected) ps.rejected++;
        } else if (connType === "suggestion_accepted") {
          ps.suggestionAccepted++;
        }
      }
    }

    // 8. Build partner summaries
    const partnerSummaries: PartnerSummary[] = [...perPartner.entries()]
      .map(([pId, stats]) => ({
        partnerId: pId,
        partnerName: partnerMap.get(pId) || pId,
        totalConnections: stats.total,
        manualCount: stats.manual,
        autoCount: stats.auto,
        suggestionAcceptedCount: stats.suggestionAccepted,
        missedSuggestions: stats.missed,
        rejections: stats.rejected,
        accuracy:
          stats.auto > 0
            ? Math.round(((stats.auto - stats.rejected) / stats.auto) * 100)
            : 100,
      }))
      .sort((a, b) => b.totalConnections - a.totalConnections);

    const totalConnections = connections.length;
    const autoMatchAccuracy =
      totalAuto > 0 ? Math.round((autoCorrect / totalAuto) * 100) : 0;
    const suggestionAcceptRate =
      totalSuggestionAccepted + dismissals.length > 0
        ? Math.round(
            (totalSuggestionAccepted /
              (totalSuggestionAccepted + dismissals.length)) *
              100
          )
        : 0;

    const report: MatchIntelligenceReport = {
      connections,
      rejections,
      dismissals,
      partnerSummaries,
      totals: {
        totalConnections,
        manualConnections: totalManual,
        autoConnections: totalAuto,
        suggestionAccepted: totalSuggestionAccepted,
        totalRejections: rejections.length,
        totalDismissals: dismissals.length,
        missedSuggestions: totalMissed,
        autoMatchAccuracy,
        suggestionAcceptRate,
      },
      exportedAt: new Date().toISOString(),
    };

    console.log(
      `[MatchIntelligence] Exported ${totalConnections} connections, ` +
        `${rejections.length} rejections, ${dismissals.length} dismissals ` +
        `for user ${ctx.userId}`
    );

    return { success: true, report };
  }
);
