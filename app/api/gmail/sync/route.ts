export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { toDateSafe } from "@/lib/utils";
import { queueIncompleteTransactionSearch } from "@/functions/src/precision-search/queueIncompleteSearch";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";

/** Thrown inside the enqueue transaction when a concurrent press won the race. */
class ManualSyncRateLimitedError extends Error {}

/** A span of mail to fetch, inclusive at both ends. */
/**
 * POST /api/gmail/sync
 * "Search for missing receipts" on a mailbox (#103).
 *
 * FiBuKI no longer syncs mailboxes: this queues the per-Transaction receipt
 * search for the user's incomplete Transactions, which asks the mailbox for
 * exactly the receipt each one is missing. Nothing is bulk-downloaded.
 *
 * Body: { integrationId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { integrationId } = (await request.json()) as { integrationId?: string };

    if (!integrationId) {
      return NextResponse.json({ error: "integrationId is required" }, { status: 400 });
    }

    const integrationRef = db.collection(INTEGRATIONS_COLLECTION).doc(integrationId);
    const integrationSnap = await integrationRef.get();
    const integration = integrationSnap.data();
    if (!integrationSnap.exists || !integration || integration.userId !== userId) {
      return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    }

    if (integration.needsReauth) {
      return NextResponse.json(
        { error: "Re-authentication required", code: "REAUTH_REQUIRED" },
        { status: 403 }
      );
    }

    // A press queues work against the user's AI budget; one per five minutes.
    const lastPress = toDateSafe(integration.lastManualSyncAt);
    if (lastPress && lastPress > new Date(Date.now() - 5 * 60 * 1000)) {
      return NextResponse.json(
        { error: "Please wait at least 5 minutes between searches", code: "RATE_LIMITED" },
        { status: 429 }
      );
    }
    await integrationRef.update({ lastManualSyncAt: Timestamp.now(), updatedAt: Timestamp.now() });

    const { queued, transactionsToProcess } = await queueIncompleteTransactionSearch(
      db,
      userId,
      "manual_search",
      { integrationId }
    );

    return NextResponse.json({
      success: true,
      searchQueued: queued,
      transactionsToProcess,
      message: queued
        ? `Searching for the receipts of ${transactionsToProcess} open transactions.`
        : "Nothing to start: a search is already running or every transaction is documented.",
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Mail search] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start the search" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/gmail/sync?integrationId={id}
 * Get sync status for an integration
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const integrationId = request.nextUrl.searchParams.get("integrationId");

    if (!integrationId) {
      return NextResponse.json(
        { error: "integrationId is required" },
        { status: 400 }
      );
    }

    // Verify integration exists and belongs to user
    const integrationRef = db.collection(INTEGRATIONS_COLLECTION).doc(integrationId);
    const integrationSnap = await integrationRef.get();

    if (!integrationSnap.exists) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    const integration = integrationSnap.data()!;
    if (integration.userId !== userId) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    // Get active sync queue items
    const activeSnapshot = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "in", ["pending", "processing"])
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    const activeSyncs = activeSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Get most recent completed sync
    const completedSnapshot = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "in", ["completed", "failed"])
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    const recentCompleted = completedSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))[0];

    return NextResponse.json({
      integration: {
        email: integration.email,
        lastSyncAt: toDateSafe(integration.lastSyncAt)?.toISOString() || null,
        lastSyncStatus: integration.lastSyncStatus || null,
        lastSyncError: integration.lastSyncError || null,
        lastSyncFileCount: integration.lastSyncFileCount || 0,
        initialSyncComplete: integration.initialSyncComplete || false,
        initialSyncStartedAt:
          toDateSafe(integration.initialSyncStartedAt)?.toISOString() || null,
      },
      activeSyncs,
      recentCompleted: recentCompleted || null,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Gmail Sync] Error:", error);
    return NextResponse.json(
      { error: "Failed to get sync status" },
      { status: 500 }
    );
  }
}
