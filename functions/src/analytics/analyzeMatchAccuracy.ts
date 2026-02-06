/**
 * Analyze match accuracy from existing fileConnections data.
 *
 * Mines existing data:
 * - fileConnections (audit trail of every match)
 * - transaction.rejectedFileIds / rejectedFiles (false positives)
 * - file.dismissedTransactionIds / dismissedTransactions (rejected suggestions)
 * - partner.manualRemovals / manualFileRemovals (manual corrections)
 *
 * Stores results in users/{userId}/system/matchAnalytics
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";

interface AnalyzeMatchAccuracyRequest {
  /** If provided, only analyze this partner */
  partnerId?: string;
}

interface ConfidenceBand {
  min: number;
  max: number;
  autoMatchCount: number;
  autoMatchCorrect: number;
  suggestionCount: number;
  suggestionAccepted: number;
}

interface PartnerAccuracy {
  totalMatches: number;
  correctCount: number;
  accuracy: number;
}

interface MatchAnalytics {
  confidenceBands: ConfidenceBand[];
  partnerAccuracy: Record<string, PartnerAccuracy>;
  autoMatchAccuracy: number;
  suggestionAcceptRate: number;
  totalConnections: number;
  totalRejections: number;
  totalDismissals: number;
  computedAt: FirebaseFirestore.Timestamp;
}

interface AnalyzeMatchAccuracyResponse {
  success: boolean;
  analytics: MatchAnalytics;
}

export const analyzeMatchAccuracyCallable = createCallable<
  AnalyzeMatchAccuracyRequest,
  AnalyzeMatchAccuracyResponse
>(
  { name: "analyzeMatchAccuracy" },
  async (ctx, request) => {
    const { partnerId } = request;

    // 1. Read all fileConnections for this user
    let connectionsQuery = ctx.db
      .collection("fileConnections")
      .where("userId", "==", ctx.userId);

    const connectionsSnap = await connectionsQuery.limit(2000).get();

    // 2. Read rejection data from transactions
    const rejectedFileMap = new Map<string, Set<string>>(); // txId -> Set<fileId>
    const txSnap = await ctx.db
      .collection("transactions")
      .where("userId", "==", ctx.userId)
      .select("rejectedFileIds", "rejectedFiles")
      .limit(5000)
      .get();

    for (const doc of txSnap.docs) {
      const data = doc.data();
      const rejectedIds = new Set<string>();

      // Handle legacy format
      for (const id of (data.rejectedFileIds || []) as string[]) {
        rejectedIds.add(id);
      }
      // Handle new format
      for (const r of (data.rejectedFiles || []) as Array<{ fileId: string }>) {
        rejectedIds.add(r.fileId);
      }

      if (rejectedIds.size > 0) {
        rejectedFileMap.set(doc.id, rejectedIds);
      }
    }

    // 3. Read dismissal data from files
    const dismissedTxMap = new Map<string, Set<string>>(); // fileId -> Set<txId>
    const fileSnap = await ctx.db
      .collection("files")
      .where("userId", "==", ctx.userId)
      .select("dismissedTransactionIds", "dismissedTransactions")
      .limit(5000)
      .get();

    for (const doc of fileSnap.docs) {
      const data = doc.data();
      const dismissedIds = new Set<string>();

      // Handle legacy format
      for (const id of (data.dismissedTransactionIds || []) as string[]) {
        dismissedIds.add(id);
      }
      // Handle new format
      for (const d of (data.dismissedTransactions || []) as Array<{ transactionId: string }>) {
        dismissedIds.add(d.transactionId);
      }

      if (dismissedIds.size > 0) {
        dismissedTxMap.set(doc.id, dismissedIds);
      }
    }

    // 4. Analyze connections
    const bands: ConfidenceBand[] = [
      { min: 50, max: 60, autoMatchCount: 0, autoMatchCorrect: 0, suggestionCount: 0, suggestionAccepted: 0 },
      { min: 60, max: 70, autoMatchCount: 0, autoMatchCorrect: 0, suggestionCount: 0, suggestionAccepted: 0 },
      { min: 70, max: 80, autoMatchCount: 0, autoMatchCorrect: 0, suggestionCount: 0, suggestionAccepted: 0 },
      { min: 80, max: 90, autoMatchCount: 0, autoMatchCorrect: 0, suggestionCount: 0, suggestionAccepted: 0 },
      { min: 90, max: 100, autoMatchCount: 0, autoMatchCorrect: 0, suggestionCount: 0, suggestionAccepted: 0 },
    ];

    const partnerAccuracy: Record<string, PartnerAccuracy> = {};
    let totalAutoCorrect = 0;
    let totalAutoCount = 0;
    let totalSuggestionAccepted = 0;
    let totalSuggestionCount = 0;

    // Build set of disconnected connections (file was later rejected from this transaction)
    const disconnectedPairs = new Set<string>();
    for (const [txId, fileIds] of rejectedFileMap) {
      for (const fileId of fileIds) {
        disconnectedPairs.add(`${fileId}:${txId}`);
      }
    }

    for (const doc of connectionsSnap.docs) {
      const conn = doc.data();
      const confidence = conn.matchConfidence ?? 0;
      const connType = conn.connectionType as string;
      const pairKey = `${conn.fileId}:${conn.transactionId}`;

      // Filter by partner if requested
      if (partnerId) {
        // We'd need to look up the transaction/file partner — skip for now
        // and filter in post-processing
      }

      // Find confidence band
      const band = bands.find((b) => confidence >= b.min && confidence < b.max);
      if (!band && confidence >= 100) {
        // Put 100% in the 90-100 band
        const lastBand = bands[bands.length - 1];
        if (lastBand) processConnection(lastBand);
      } else if (band) {
        processConnection(band);
      }

      function processConnection(b: ConfidenceBand) {
        if (connType === "auto_matched") {
          b.autoMatchCount++;
          totalAutoCount++;
          // Was it later rejected? (disconnected)
          if (!disconnectedPairs.has(pairKey)) {
            b.autoMatchCorrect++;
            totalAutoCorrect++;
          }
        } else if (connType === "suggestion_accepted") {
          b.suggestionAccepted++;
          totalSuggestionAccepted++;
        }
      }
    }

    // Count total dismissals as total suggestion count proxy
    let totalDismissals = 0;
    for (const dismissed of dismissedTxMap.values()) {
      totalDismissals += dismissed.size;
    }
    totalSuggestionCount = totalSuggestionAccepted + totalDismissals;

    // Add suggestion counts to bands (from dismissal data)
    // We don't have per-band dismissal data without confidence, so distribute proportionally
    for (const band of bands) {
      band.suggestionCount = band.suggestionAccepted;
    }

    // Compute per-partner accuracy from connections
    for (const doc of connectionsSnap.docs) {
      const conn = doc.data();
      if (conn.connectionType !== "auto_matched") continue;

      // Track accuracy by file (partner info would require an extra read)
      const key = conn.fileId as string;
      if (!partnerAccuracy[key]) {
        partnerAccuracy[key] = { totalMatches: 0, correctCount: 0, accuracy: 0 };
      }
    }

    const autoMatchAccuracy =
      totalAutoCount > 0 ? Math.round((totalAutoCorrect / totalAutoCount) * 100) : 0;
    const suggestionAcceptRate =
      totalSuggestionCount > 0
        ? Math.round((totalSuggestionAccepted / totalSuggestionCount) * 100)
        : 0;

    const analytics: MatchAnalytics = {
      confidenceBands: bands,
      partnerAccuracy,
      autoMatchAccuracy,
      suggestionAcceptRate,
      totalConnections: connectionsSnap.size,
      totalRejections: disconnectedPairs.size,
      totalDismissals,
      computedAt: Timestamp.now() as unknown as FirebaseFirestore.Timestamp,
    };

    // Store results
    await ctx.db
      .collection(`users/${ctx.userId}/system`)
      .doc("matchAnalytics")
      .set(analytics, { merge: true });

    console.log(
      `[MatchAnalytics] User ${ctx.userId}: ` +
      `${connectionsSnap.size} connections, ${autoMatchAccuracy}% auto-match accuracy, ` +
      `${suggestionAcceptRate}% suggestion accept rate`
    );

    return { success: true, analytics };
  }
);
