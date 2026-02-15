export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";
const TRANSACTIONS_COLLECTION = "transactions";

/**
 * POST /api/gmail/sync
 * Manually trigger a sync for a Gmail integration
 *
 * Body: {
 *   integrationId: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { integrationId } = body;

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

    if (integration.needsReauth) {
      return NextResponse.json(
        {
          error: "Re-authentication required",
          code: "REAUTH_REQUIRED",
        },
        { status: 403 }
      );
    }

    // Only block if initial sync is actively in progress (started but not complete)
    if (integration.initialSyncComplete === false && integration.initialSyncStartedAt) {
      return NextResponse.json(
        {
          error: "Initial sync still in progress",
          code: "INITIAL_SYNC_PENDING",
        },
        { status: 400 }
      );
    }

    // Check for rate limiting (max 1 manual sync per 5 minutes per integration)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (
      integration.lastSyncAt &&
      integration.lastSyncAt.toDate() > fiveMinutesAgo
    ) {
      return NextResponse.json(
        {
          error: "Please wait at least 5 minutes between syncs",
          code: "RATE_LIMITED",
        },
        { status: 429 }
      );
    }

    // Clean up any stale queue items first (processing for > 30 minutes)
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const staleQuery = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "==", "processing")
      .get();

    let cleanedUp = 0;
    for (const doc of staleQuery.docs) {
      const data = doc.data();
      const startedAt = data.startedAt?.toDate() || data.createdAt?.toDate();
      if (startedAt && startedAt < staleThreshold) {
        await doc.ref.update({
          status: "failed",
          error: "Sync timed out",
          updatedAt: Timestamp.now(),
        });
        cleanedUp++;
      }
    }

    if (cleanedUp > 0) {
      console.log(`[Gmail Sync] Cleaned up ${cleanedUp} stale queue item(s)`);
    }

    // Check if there's already a pending sync (non-stale)
    const pendingQuery = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "in", ["pending", "processing"])
      .limit(1)
      .get();

    if (!pendingQuery.empty) {
      return NextResponse.json(
        {
          error: "A sync is already in progress",
          code: "SYNC_IN_PROGRESS",
        },
        { status: 400 }
      );
    }

    // Get date range from transactions
    const gapsToSync = await getSyncDateRanges(userId, integrationId, integration);

    if (gapsToSync.length === 0) {
      // No gaps - already fully synced for current transaction range
      return NextResponse.json({
        success: true,
        message: "Already up to date",
        alreadySynced: true,
      });
    }

    // Create queue items for each gap
    const now = Timestamp.now();
    const queueIds: string[] = [];

    for (const gap of gapsToSync) {
      const queueRef = await db.collection(SYNC_QUEUE_COLLECTION).add({
        userId,
        integrationId,
        type: "manual",
        status: "pending",
        dateFrom: Timestamp.fromDate(gap.from),
        dateTo: Timestamp.fromDate(gap.to),
        emailsProcessed: 0,
        filesCreated: 0,
        attachmentsSkipped: 0,
        errors: [],
        retryCount: 0,
        maxRetries: 3,
        processedMessageIds: [],
        createdAt: now,
      });
      queueIds.push(queueRef.id);

      console.log(
        `[Gmail Sync] Queued manual sync for ${integration.email}: ${queueRef.id} ` +
        `(${gap.from.toISOString()} - ${gap.to.toISOString()})`
      );
    }

    return NextResponse.json({
      success: true,
      message: `Sync started for ${gapsToSync.length} date range(s)`,
      queueIds,
    });
  } catch (error) {
    console.error("[Gmail Sync] Error:", error);
    return NextResponse.json(
      { error: "Failed to start sync" },
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
        lastSyncAt: integration.lastSyncAt?.toDate().toISOString() || null,
        lastSyncStatus: integration.lastSyncStatus || null,
        lastSyncError: integration.lastSyncError || null,
        lastSyncFileCount: integration.lastSyncFileCount || 0,
        initialSyncComplete: integration.initialSyncComplete || false,
        initialSyncStartedAt:
          integration.initialSyncStartedAt?.toDate().toISOString() || null,
      },
      activeSyncs,
      recentCompleted: recentCompleted || null,
    });
  } catch (error) {
    console.error("[Gmail Sync] Error:", error);
    return NextResponse.json(
      { error: "Failed to get sync status" },
      { status: 500 }
    );
  }
}

/**
 * Get date ranges that need syncing
 */
async function getSyncDateRanges(
  userId: string,
  integrationId: string,
  integration: FirebaseFirestore.DocumentData
): Promise<{ from: Date; to: Date }[]> {
  // Get transaction date range
  const transactionsQuery = await db
    .collection(TRANSACTIONS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("date", "asc")
    .limit(1)
    .get();

  if (transactionsQuery.empty) {
    // No transactions - sync last 90 days
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 90);
    return [{ from, to }];
  }

  const oldestTransaction = transactionsQuery.docs[0].data();
  const oldestDate = oldestTransaction.date.toDate();

  // Get most recent transaction
  const recentQuery = await db
    .collection(TRANSACTIONS_COLLECTION)
    .where("userId", "==", userId)
    .orderBy("date", "desc")
    .limit(1)
    .get();

  const newestTransaction = recentQuery.docs[0]?.data();
  const newestDate = newestTransaction?.date.toDate() || new Date();

  // Add buffer days
  const from = new Date(oldestDate);
  from.setDate(from.getDate() - 7);
  const to = new Date(newestDate);
  to.setDate(to.getDate() + 7);

  // Check what's already synced (field is syncedDateRange.from/to, written by gmailSyncQueue.ts)
  const syncedFrom = integration.syncedDateRange?.from?.toDate();
  const syncedTo = integration.syncedDateRange?.to?.toDate();

  if (!syncedFrom || !syncedTo) {
    // Nothing synced yet
    return [{ from, to }];
  }

  // Find gaps
  const gaps: { from: Date; to: Date }[] = [];

  if (from < syncedFrom) {
    gaps.push({ from, to: new Date(syncedFrom.getTime() - 1) });
  }

  if (to > syncedTo) {
    gaps.push({ from: new Date(syncedTo.getTime() + 1), to });
  }

  return gaps;
}
