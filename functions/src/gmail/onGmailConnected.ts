import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const db = getFirestore();

// ============================================================================
// Types
// ============================================================================

interface EmailIntegration {
  userId: string;
  provider: string;
  email: string;
  isActive: boolean;
  needsReauth: boolean;
  initialSyncComplete?: boolean;
}

// ============================================================================
// Trigger on Gmail Connection
// ============================================================================

/**
 * Triggered when a new email integration is created.
 * If it's a Gmail integration, queues the initial invoice sync.
 */
export const onGmailConnected = onDocumentCreated(
  {
    document: "emailIntegrations/{integrationId}",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const data = event.data?.data() as EmailIntegration | undefined;
    if (!data) {
      console.log("[GmailSync] No data in created document");
      return;
    }

    // Only process Gmail integrations
    if (data.provider !== "gmail") {
      console.log(`[GmailSync] Integration is ${data.provider}, not Gmail, skipping`);
      return;
    }

    // Skip if inactive or needs reauth
    if (!data.isActive || data.needsReauth) {
      console.log("[GmailSync] Integration is inactive or needs reauth, skipping");
      return;
    }

    const integrationId = event.params.integrationId;
    const userId = data.userId;

    console.log(`[GmailSync] New Gmail integration created: ${data.email}`);

    try {
      // Get transaction date range for time-bounded sync
      const dateRange = await getTransactionDateRange(userId);

      let dateFrom: Date;
      let dateTo: Date;

      if (dateRange) {
        // Extend range slightly to catch invoices for transactions
        dateFrom = new Date(dateRange.minDate);
        dateFrom.setDate(dateFrom.getDate() - 7); // 7 days before first transaction

        dateTo = new Date(dateRange.maxDate);
        dateTo.setDate(dateTo.getDate() + 7); // 7 days after last transaction
      } else {
        // No transactions, sync last 90 days
        dateTo = new Date();
        dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - 90);
      }

      console.log(`[GmailSync] Date range: ${dateFrom.toISOString()} to ${dateTo.toISOString()}`);

      // Mark initial sync as ready but paused (user must manually start)
      const now = Timestamp.now();
      await event.data?.ref.update({
        initialSyncStartedAt: now,
        isPaused: true,
        pausedAt: now,
        updatedAt: now,
      });

      // Create sync queue item (paused - user must manually resume)
      await db.collection("gmailSyncQueue").add({
        userId,
        integrationId,
        type: "initial",
        status: "paused",
        dateFrom: Timestamp.fromDate(dateFrom),
        dateTo: Timestamp.fromDate(dateTo),
        emailsProcessed: 0,
        filesCreated: 0,
        attachmentsSkipped: 0,
        errors: [],
        retryCount: 0,
        maxRetries: 3,
        processedMessageIds: [],
        createdAt: now,
      });

      console.log(`[GmailSync] Gmail integration ready (paused): ${data.email}`);

      // Create notification for user
      await db.collection("notifications").add({
        userId,
        type: "gmail_sync_ready",
        title: "Gmail Connected",
        message: `${data.email} is ready. Start syncing from the Integrations page when you're ready.`,
        read: false,
        createdAt: now,
      });
    } catch (error) {
      console.error(`[GmailSync] Error setting up initial sync:`, error);

      // Update integration with error
      await event.data?.ref.update({
        lastSyncError: error instanceof Error ? error.message : "Failed to start initial sync",
        updatedAt: Timestamp.now(),
      });
    }
  }
);

// ============================================================================
// Trigger on Gmail Reconnection
// ============================================================================

/**
 * Triggered when an email integration is updated.
 * If needsReauth changes from true to false (reconnection), resume paused queues.
 */
export const onGmailReconnected = onDocumentUpdated(
  {
    document: "emailIntegrations/{integrationId}",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const beforeData = event.data?.before.data() as EmailIntegration | undefined;
    const afterData = event.data?.after.data() as EmailIntegration | undefined;

    if (!beforeData || !afterData) {
      return;
    }

    // Check if this is a reconnection (needsReauth: true -> false)
    const wasDisconnected = beforeData.needsReauth === true;
    const isNowConnected = afterData.needsReauth === false && afterData.isActive;

    if (!wasDisconnected || !isNowConnected) {
      return;
    }

    const integrationId = event.params.integrationId;
    const userId = afterData.userId;

    console.log(`[GmailSync] Gmail reconnected: ${afterData.email}, resuming paused queues`);

    try {
      // Resume paused gmailSyncQueue items for this integration
      const pausedSyncItems = await db
        .collection("gmailSyncQueue")
        .where("integrationId", "==", integrationId)
        .where("status", "==", "paused")
        .get();

      for (const doc of pausedSyncItems.docs) {
        await doc.ref.update({
          status: "pending",
          lastError: null,
        });
        console.log(`[GmailSync] Resumed gmailSyncQueue item: ${doc.id}`);
      }

      // Resume paused precisionSearchQueue items for this user
      // (they might have been paused due to this integration needing reauth)
      const pausedSearchItems = await db
        .collection("precisionSearchQueue")
        .where("userId", "==", userId)
        .where("status", "==", "pending")
        .get();

      // Check if the lastError indicates it was paused for Gmail reauth
      for (const doc of pausedSearchItems.docs) {
        const data = doc.data();
        if (data.lastError?.includes("Gmail") && data.lastError?.includes("reconnect")) {
          await doc.ref.update({
            lastError: null,
          });
          console.log(`[GmailSync] Cleared error on precisionSearchQueue item: ${doc.id}`);
        }
      }

      // Create notification for user
      await db.collection("notifications").add({
        userId,
        type: "gmail_reconnected",
        title: "Gmail Reconnected",
        message: `${afterData.email} is reconnected. Paused syncs will resume automatically.`,
        read: false,
        createdAt: Timestamp.now(),
      });

      console.log(
        `[GmailSync] Resumed ${pausedSyncItems.size} paused sync items after Gmail reconnection`
      );
    } catch (error) {
      console.error(`[GmailSync] Error resuming paused queues:`, error);
    }
  }
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the date range of the user's transactions.
 * Used to limit invoice search to relevant dates.
 */
async function getTransactionDateRange(
  userId: string
): Promise<{ minDate: Date; maxDate: Date } | null> {
  console.log(`[GmailSync] Querying transactions for userId: ${userId}`);

  // Get earliest transaction
  const earliestQuery = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "asc")
    .limit(1)
    .get();

  // Get latest transaction
  const latestQuery = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "desc")
    .limit(1)
    .get();

  console.log(`[GmailSync] Found ${earliestQuery.size} earliest, ${latestQuery.size} latest transactions`);

  if (earliestQuery.empty || latestQuery.empty) {
    console.log(`[GmailSync] No transactions found for user, will use fallback date range`);
    return null;
  }

  const earliestDoc = earliestQuery.docs[0].data();
  const latestDoc = latestQuery.docs[0].data();

  // Handle both Timestamp and Date objects
  const minDate =
    earliestDoc.date instanceof Timestamp
      ? earliestDoc.date.toDate()
      : new Date(earliestDoc.date);
  const maxDate =
    latestDoc.date instanceof Timestamp
      ? latestDoc.date.toDate()
      : new Date(latestDoc.date);

  return { minDate, maxDate };
}
