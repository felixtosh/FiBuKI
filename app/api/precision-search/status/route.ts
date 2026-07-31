export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

const db = getAdminDb();

/**
 * GET /api/precision-search/status
 * Get precision search status and history
 *
 * Query params:
 *   - queueId: Get status of a specific queue item
 *   - transactionId: Get search history for a specific transaction
 *
 * Returns: {
 *   queueItem?: PrecisionSearchQueueItem;
 *   history?: TransactionSearchEntry[];
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const queueId = request.nextUrl.searchParams.get("queueId");
    const transactionId = request.nextUrl.searchParams.get("transactionId");

    if (!queueId && !transactionId) {
      return NextResponse.json(
        { error: "Either queueId or transactionId is required" },
        { status: 400 }
      );
    }

    const result: Record<string, unknown> = {};

    // Get queue item if requested
    if (queueId) {
      const queueDoc = await db.collection("precisionSearchQueue").doc(queueId).get();

      if (!queueDoc.exists) {
        return NextResponse.json(
          { error: "Queue item not found" },
          { status: 404 }
        );
      }

      const queueData = queueDoc.data()!;

      // Security check: ensure user owns this queue item
      if (queueData.userId !== userId) {
        return NextResponse.json(
          { error: "Queue item not found" },
          { status: 404 }
        );
      }

      result.queueItem = {
        id: queueDoc.id,
        status: queueData.status,
        scope: queueData.scope,
        triggeredBy: queueData.triggeredBy,
        progress: queueData.transactionsToProcess > 0
          ? Math.round((queueData.transactionsProcessed / queueData.transactionsToProcess) * 100)
          : 0,
        currentStrategyIndex: queueData.currentStrategyIndex || 0,
        transactionsProcessed: queueData.transactionsProcessed,
        transactionsToProcess: queueData.transactionsToProcess,
        transactionsWithMatches: queueData.transactionsWithMatches,
        totalFilesConnected: queueData.totalFilesConnected,
        errors: queueData.errors,
        lastError: queueData.lastError,
        createdAt: queueData.createdAt,
        startedAt: queueData.startedAt,
        completedAt: queueData.completedAt,
      };
    }

    // Get transaction search history if requested
    if (transactionId) {
      const searchesSnapshot = await db
        .collection("transactions")
        .doc(transactionId)
        .collection("searches")
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();

      result.history = searchesSnapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          triggeredBy: data.triggeredBy,
          status: data.status,
          strategiesAttempted: data.strategiesAttempted || [],
          totalFilesConnected: data.totalFilesConnected || 0,
          automationSource: data.automationSource,
          totalGeminiCalls: data.totalGeminiCalls || 0,
          createdAt: data.createdAt,
          completedAt: data.completedAt,
          attempts: (data.attempts || []).map((attempt: Record<string, unknown>) => ({
            strategy: attempt.strategy,
            candidatesFound: attempt.candidatesFound,
            matchesFound: attempt.matchesFound,
            fileIdsConnected: attempt.fileIdsConnected,
            error: attempt.error,
            searchParams: attempt.searchParams,
          })),
        };
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[PrecisionSearch API] Error getting status:", error);
    return NextResponse.json(
      { error: "Failed to get precision search status" },
      { status: 500 }
    );
  }
}
