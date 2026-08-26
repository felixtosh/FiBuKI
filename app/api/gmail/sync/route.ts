export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { toDateSafe } from "@/lib/utils";
import { MANUAL_SYNC_WINDOW_DAYS } from "@/functions/src/mail/constants";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";
const TRANSACTIONS_COLLECTION = "transactions";

/** Thrown inside the enqueue transaction when a concurrent press won the race. */
class ManualSyncRateLimitedError extends Error {}

/** A span of mail to fetch, inclusive at both ends. */
interface DateRange {
  from: Date;
  to: Date;
}

/**
 * POST /api/gmail/sync
 * Manually trigger a sync for a Gmail integration
 *
 * Body: {
 *   integrationId: string;
 *   force?: boolean;   // also sync a trailing window, not just detected gaps
 * }
 *
 * `force` exists because gap detection alone reports "already up to date"
 * whenever the synced range already runs to now — which is the normal state
 * right after a nightly sync, and therefore the normal state when a human
 * presses the button. With the flag set the trailing MANUAL_SYNC_WINDOW_DAYS
 * are queued *in addition to* any real gap. The Gmail button does not send it,
 * so Gmail keeps pure gap-fill behaviour.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { integrationId, force } = body as {
      integrationId?: string;
      force?: boolean;
    };

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

    // Rate limiting: max 1 *manual press* per 5 minutes per integration.
    //
    // Keyed on lastManualSyncAt, not lastSyncAt: the latter is written by the
    // worker on any completed sync, so a nightly run would otherwise consume
    // the user's throttle for a job they did not initiate.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const lastManualSyncAt = toDateSafe(integration.lastManualSyncAt);
    if (lastManualSyncAt && lastManualSyncAt > fiveMinutesAgo) {
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
      const startedAt = toDateSafe(data.startedAt) || toDateSafe(data.createdAt);
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

    // A forced press always covers the trailing window as well, merged with the
    // gaps so an overlapping pair does not become two queue items.
    const rangesToSync = force
      ? mergeDateRanges([...gapsToSync, manualSyncWindow()])
      : gapsToSync;

    if (rangesToSync.length === 0) {
      // No gaps - already fully synced for current transaction range
      return NextResponse.json({
        success: true,
        message: "Already up to date",
        alreadySynced: true,
      });
    }

    // Create queue items for each range, stamping the throttle in the same
    // transaction as the check. The plain check above (line ~99) is only a
    // cheap short-circuit; two concurrent presses can both pass it before
    // either writes. Re-reading lastManualSyncAt here and stamping it in the
    // same transaction closes that window — a second press's transaction
    // sees the first press's fresh stamp and is rejected.
    const now = Timestamp.now();
    const queueIds: string[] = [];

    try {
      await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(integrationRef);
        const freshLastManualSyncAt = toDateSafe(freshSnap.data()?.lastManualSyncAt);
        if (freshLastManualSyncAt && freshLastManualSyncAt > fiveMinutesAgo) {
          throw new ManualSyncRateLimitedError();
        }

        tx.update(integrationRef, { lastManualSyncAt: now, updatedAt: now });

        for (const gap of rangesToSync) {
          const queueRef = db.collection(SYNC_QUEUE_COLLECTION).doc();
          tx.set(queueRef, {
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
        }
      });
    } catch (error) {
      if (error instanceof ManualSyncRateLimitedError) {
        return NextResponse.json(
          {
            error: "Please wait at least 5 minutes between syncs",
            code: "RATE_LIMITED",
          },
          { status: 429 }
        );
      }
      throw error;
    }

    rangesToSync.forEach((gap, i) => {
      console.log(
        `[Gmail Sync] Queued manual sync for ${integration.email}: ${queueIds[i]} ` +
        `(${gap.from.toISOString()} - ${gap.to.toISOString()})`
      );
    });

    return NextResponse.json({
      success: true,
      message: `Sync started for ${rangesToSync.length} date range(s)`,
      queueIds,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
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

/**
 * Get date ranges that need syncing
 */
async function getSyncDateRanges(
  userId: string,
  integrationId: string,
  integration: FirebaseFirestore.DocumentData
): Promise<DateRange[]> {
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
  const syncedFrom = toDateSafe(integration.syncedDateRange?.from);
  const syncedTo = toDateSafe(integration.syncedDateRange?.to);

  if (!syncedFrom || !syncedTo) {
    // Nothing synced yet
    return [{ from, to }];
  }

  // Find gaps
  const gaps: DateRange[] = [];

  if (from < syncedFrom) {
    gaps.push({ from, to: new Date(syncedFrom.getTime() - 1) });
  }

  if (to > syncedTo) {
    gaps.push({ from: new Date(syncedTo.getTime() + 1), to });
  }

  return gaps;
}

/**
 * The trailing window a forced press covers, ending now.
 */
function manualSyncWindow(): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - MANUAL_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

/**
 * Collapse overlapping or touching ranges into the fewest that cover the same
 * span, so a forced window that already sits inside a detected gap does not
 * queue the same mail twice.
 *
 * Ranges built by getSyncDateRanges are separated by exactly 1ms at their
 * seams, so anything within 1ms counts as touching.
 */
function mergeDateRanges(ranges: DateRange[]): DateRange[] {
  const sorted = [...ranges].sort((a, b) => a.from.getTime() - b.from.getTime());
  const merged: DateRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from.getTime() <= last.to.getTime() + 1) {
      if (range.to > last.to) last.to = new Date(range.to);
    } else {
      merged.push({ from: new Date(range.from), to: new Date(range.to) });
    }
  }

  return merged;
}
