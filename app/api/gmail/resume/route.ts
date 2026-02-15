export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";

/**
 * POST /api/gmail/resume
 * Resume sync for a Gmail integration
 * Also triggers an immediate sync
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

    // Resume the integration
    await integrationRef.update({
      isPaused: false,
      pausedAt: null,
      updatedAt: Timestamp.now(),
    });
    console.log(`[Gmail Resume] Resumed integration: ${integration.email}`);

    // Check if reauth is needed
    if (integration.needsReauth) {
      return NextResponse.json({
        success: true,
        message: "Sync resumed, but re-authentication is required",
        needsReauth: true,
        syncStarted: false,
      });
    }

    // Restart paused queue items by deleting and recreating them.
    // This triggers onSyncQueueCreated for immediate processing
    // (just updating status to "pending" wouldn't trigger any Cloud Function).
    const staleItemsQuery = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "==", "paused")
      .get();

    let cleanedUp = 0;
    for (const doc of staleItemsQuery.docs) {
      const data = doc.data();
      // Delete the paused item and create a fresh one to trigger onSyncQueueCreated
      await doc.ref.delete();
      await db.collection(SYNC_QUEUE_COLLECTION).add({
        userId: data.userId,
        integrationId: data.integrationId,
        type: data.type,
        status: "pending",
        dateFrom: data.dateFrom,
        dateTo: data.dateTo,
        // Clear nextPageToken — it's likely stale after pause; already-processed
        // messages will be skipped via processedMessageIds
        nextPageToken: null,
        emailsProcessed: data.emailsProcessed || 0,
        filesCreated: data.filesCreated || 0,
        attachmentsSkipped: data.attachmentsSkipped || 0,
        errors: data.errors || [],
        retryCount: 0,
        maxRetries: data.maxRetries || 3,
        processedMessageIds: data.processedMessageIds || [],
        createdAt: Timestamp.now(),
      });
      cleanedUp++;
    }

    if (cleanedUp > 0) {
      console.log(`[Gmail Resume] Recreated ${cleanedUp} paused queue item(s) for immediate processing`);
      return NextResponse.json({
        success: true,
        message: `Sync resumed, restarting ${cleanedUp} paused sync(s)`,
        syncStarted: true,
        restartedSyncs: cleanedUp,
      });
    }

    // Check if there's already a pending sync
    const pendingSyncsQuery = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "in", ["pending", "processing"])
      .limit(1)
      .get();

    if (!pendingSyncsQuery.empty) {
      return NextResponse.json({
        success: true,
        message: "Sync resumed, a sync is already in progress",
        syncStarted: false,
        alreadySyncing: true,
      });
    }

    // No paused or pending syncs - just resume without starting new sync
    // The next scheduled sync will pick it up
    return NextResponse.json({
      success: true,
      message: "Sync resumed, will sync on next scheduled run",
      syncStarted: false,
    });
  } catch (error) {
    console.error("[Gmail Resume] Error:", error);
    return NextResponse.json(
      { error: "Failed to resume sync" },
      { status: 500 }
    );
  }
}
