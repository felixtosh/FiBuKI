export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";
const SYNC_HISTORY_COLLECTION = "gmailSyncHistory";

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

/**
 * POST /api/gmail/pause
 * Pause sync for a Gmail integration
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

    // Check if already paused
    if (integration.isPaused) {
      return NextResponse.json({
        success: true,
        message: "Already paused",
        alreadyPaused: true,
      });
    }

    // Pause any active sync queue items
    const activeSyncsQuery = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .where("status", "in", ["pending", "processing"])
      .get();

    let pausedQueueItem: {
      type: string;
      dateFrom: Date | null;
      dateTo: Date | null;
      emailsProcessed: number;
      filesCreated: number;
      attachmentsSkipped: number;
      errors: string[];
      startedAt: FirebaseFirestore.Timestamp | null;
      createdAt: FirebaseFirestore.Timestamp;
    } | null = null;

    for (const doc of activeSyncsQuery.docs) {
      const data = doc.data();
      await doc.ref.update({
        status: "paused",
        pausedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });

      // Track the first one for history
      if (!pausedQueueItem) {
        pausedQueueItem = {
          type: data.type,
          dateFrom: data.dateFrom?.toDate() || null,
          dateTo: data.dateTo?.toDate() || null,
          emailsProcessed: data.emailsProcessed || 0,
          filesCreated: data.filesCreated || 0,
          attachmentsSkipped: data.attachmentsSkipped || 0,
          errors: data.errors || [],
          startedAt: data.startedAt || null,
          createdAt: data.createdAt,
        };
      }
    }

    // Create a sync history record showing the pause
    if (pausedQueueItem) {
      const startedAt = pausedQueueItem.startedAt || pausedQueueItem.createdAt;
      const completedAt = Timestamp.now();
      const durationSeconds = Math.round(
        (completedAt.toMillis() - startedAt.toMillis()) / 1000
      );

      await db.collection(SYNC_HISTORY_COLLECTION).add({
        userId,
        integrationId,
        integrationEmail: integration.email,
        type: pausedQueueItem.type,
        status: "paused",
        dateFrom: pausedQueueItem.dateFrom,
        dateTo: pausedQueueItem.dateTo,
        emailsSearched: pausedQueueItem.emailsProcessed,
        filesCreated: pausedQueueItem.filesCreated,
        attachmentsSkipped: pausedQueueItem.attachmentsSkipped,
        errors: pausedQueueItem.errors || [],
        startedAt,
        completedAt,
        durationSeconds,
        triggeredBy: "manual",
      });

      console.log(
        `[Gmail Pause] Created history record for paused sync: ${sanitizeForLog(integrationId)}`
      );
    }

    // Mark integration as paused
    await integrationRef.update({
      isPaused: true,
      pausedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    console.log(`[Gmail Pause] Paused integration: ${integration.email}`);

    return NextResponse.json({
      success: true,
      message: pausedQueueItem
        ? `Sync paused (${pausedQueueItem.filesCreated} files, ${pausedQueueItem.emailsProcessed} emails processed)`
        : "Sync paused",
      hadActiveSync: !!pausedQueueItem,
      pausedProgress: pausedQueueItem
        ? {
            filesCreated: pausedQueueItem.filesCreated,
            emailsProcessed: pausedQueueItem.emailsProcessed,
          }
        : null,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Gmail Pause] Error:", error);
    return NextResponse.json(
      { error: "Failed to pause sync" },
      { status: 500 }
    );
  }
}
