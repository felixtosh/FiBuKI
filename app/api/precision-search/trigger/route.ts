export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { Timestamp } from "firebase-admin/firestore";

const db = getAdminDb();

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

const DEFAULT_STRATEGIES = [
  "partner_files",
  "amount_files",
  "email_attachment",
  "email_invoice",
];

/**
 * POST /api/precision-search/trigger
 * Trigger a precision receipt search
 *
 * Body: {
 *   scope: "all_incomplete" | "single_transaction";
 *   transactionId?: string; // Required when scope is "single_transaction"
 * }
 *
 * Returns: {
 *   success: boolean;
 *   queueId: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { scope, transactionId } = body;

    if (!scope || !["all_incomplete", "single_transaction"].includes(scope)) {
      return NextResponse.json(
        { error: "Invalid scope. Must be 'all_incomplete' or 'single_transaction'" },
        { status: 400 }
      );
    }

    if (scope === "single_transaction" && !transactionId) {
      return NextResponse.json(
        { error: "transactionId is required when scope is 'single_transaction'" },
        { status: 400 }
      );
    }

    // Count transactions to process if scope is all_incomplete
    let transactionsToProcess = 1;
    if (scope === "all_incomplete") {
      const countSnapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("isComplete", "==", false)
        .count()
        .get();
      transactionsToProcess = countSnapshot.data().count;
    }

    // Build queue item using Admin SDK
    const queueItem: Record<string, unknown> = {
      userId,
      scope,
      triggeredBy: "manual",
      triggeredByAuthor: {
        type: "user",
        userId,
      },
      status: "pending",
      transactionsToProcess,
      transactionsProcessed: 0,
      transactionsWithMatches: 0,
      totalFilesConnected: 0,
      strategies: DEFAULT_STRATEGIES,
      currentStrategyIndex: 0,
      errors: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Timestamp.now(),
    };

    // Only add transactionId if scope is single_transaction
    if (scope === "single_transaction" && transactionId) {
      queueItem.transactionId = transactionId;
    }

    // Create queue item using Admin SDK (bypasses security rules)
    const docRef = await db.collection("precisionSearchQueue").add(queueItem);

    console.log(
      `[PrecisionSearch API] Queued ${sanitizeForLog(scope)} search: ${docRef.id}`,
      transactionId ? `for tx ${sanitizeForLog(transactionId)}` : ""
    );

    return NextResponse.json({
      success: true,
      queueId: docRef.id,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[PrecisionSearch API] Error triggering search:", error);
    return NextResponse.json(
      { error: "Failed to trigger precision search" },
      { status: 500 }
    );
  }
}
