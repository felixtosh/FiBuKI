import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

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
// Trigger on Mail Service Connection
// ============================================================================

/**
 * Triggered when a new email integration is created.
 * Handles provider-specific setup (Gmail sync queue, etc.)
 */
export const onMailServiceConnected = onDocumentCreated(
  {
    document: "emailIntegrations/{integrationId}",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const data = event.data?.data() as EmailIntegration | undefined;
    if (!data) {
      console.log("[MailService] No data in created document");
      return;
    }

    // Skip if inactive or needs reauth
    if (!data.isActive || data.needsReauth) {
      console.log("[MailService] Integration is inactive or needs reauth, skipping");
      return;
    }

    const integrationId = event.params.integrationId;
    const userId = data.userId;
    const provider = data.provider;

    console.log(`[MailService] New ${provider} integration created: ${data.email}`);

    try {
      // Provider-specific setup
      switch (provider) {
        case "gmail":
          await setupGmailIntegration(event, data, integrationId, userId);
          break;
        case "imap":
          await setupImapIntegration(event, data, integrationId, userId);
          break;
        // Future providers can be added here:
        // case "outlook":
        //   await setupOutlookIntegration(event, data, integrationId, userId);
        //   break;
        default:
          console.log(`[MailService] No specific setup for provider: ${provider}`);
      }
    } catch (error) {
      console.error(`[MailService] Error setting up ${provider} integration:`, error);

      // Update integration with error
      await event.data?.ref.update({
        lastSyncError: error instanceof Error ? error.message : "Failed to start initial sync",
        updatedAt: Timestamp.now(),
      });
    }
  }
);

/**
 * Gmail-specific integration setup
 */
async function setupGmailIntegration(
  event: Parameters<Parameters<typeof onDocumentCreated>[1]>[0],
  data: EmailIntegration,
  integrationId: string,
  userId: string
): Promise<void> {
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

  console.log(`[MailService] Gmail date range: ${dateFrom.toISOString()} to ${dateTo.toISOString()}`);

  // Granting Gmail OAuth signals intent to sync. Start the initial sync
  // immediately so the user sees imports without a second manual click.
  // (Was previously paused-by-default, which confused users adding a 2nd
  // account: the "Pull New Files" button stays hidden while paused, so
  // the only visible action was the less-obvious "Resume Sync".)
  const now = Timestamp.now();
  await event.data?.ref.update({
    initialSyncStartedAt: now,
    isPaused: false,
    updatedAt: now,
  });

  await db.collection("gmailSyncQueue").add({
    userId,
    integrationId,
    type: "initial",
    status: "pending",
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

  console.log(`[MailService] Gmail integration auto-started: ${data.email}`);

  await db.collection("notifications").add({
    userId,
    type: "mail_service_connected",
    title: "Gmail Connected",
    message: `${data.email} connected. Syncing recent invoices now.`,
    read: false,
    createdAt: now,
  });
}

/**
 * IMAP-specific integration setup.
 *
 * Same time-bounded initial sync as Gmail (the queue worker and item shape are
 * provider-neutral); only the connect notification differs. The mailbox was
 * already verified by the connect route before this document was written.
 */
async function setupImapIntegration(
  event: Parameters<Parameters<typeof onDocumentCreated>[1]>[0],
  data: EmailIntegration,
  integrationId: string,
  userId: string
): Promise<void> {
  const dateRange = await getTransactionDateRange(userId);

  let dateFrom: Date;
  let dateTo: Date;

  if (dateRange) {
    dateFrom = new Date(dateRange.minDate);
    dateFrom.setDate(dateFrom.getDate() - 7);
    dateTo = new Date(dateRange.maxDate);
    dateTo.setDate(dateTo.getDate() + 7);
  } else {
    dateTo = new Date();
    dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - 90);
  }

  console.log(`[MailService] IMAP date range: ${dateFrom.toISOString()} to ${dateTo.toISOString()}`);

  const now = Timestamp.now();
  await event.data?.ref.update({
    initialSyncStartedAt: now,
    isPaused: false,
    updatedAt: now,
  });

  await db.collection("gmailSyncQueue").add({
    userId,
    integrationId,
    type: "initial",
    status: "pending",
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

  console.log(`[MailService] IMAP integration auto-started: ${data.email}`);

  await db.collection("notifications").add({
    userId,
    type: "mail_service_connected",
    title: "Mailbox Connected",
    message: `${data.email} connected. Syncing recent invoices now.`,
    read: false,
    createdAt: now,
  });
}

// ============================================================================
// Trigger on Mail Service Reconnection
// ============================================================================

/**
 * Triggered when an email integration is updated.
 * If needsReauth changes from true to false (reconnection), resume paused queues
 * and trigger precision search for transactions that were skipped.
 */
export const onMailServiceReconnected = onDocumentUpdated(
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
    const provider = afterData.provider;

    console.log(`[MailService] ${provider} reconnected: ${afterData.email}, resuming paused queues`);

    try {
      // Provider-specific queue resumption
      if (provider === "gmail") {
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
          console.log(`[MailService] Resumed gmailSyncQueue item: ${doc.id}`);
        }

        console.log(
          `[MailService] Resumed ${pausedSyncItems.size} paused sync items after ${provider} reconnection`
        );
      }

      // Resume paused precisionSearchQueue items for this user
      // (they might have been paused due to this integration needing reauth)
      const pausedSearchItems = await db
        .collection("precisionSearchQueue")
        .where("userId", "==", userId)
        .where("status", "==", "pending")
        .get();

      // Check if the lastError indicates it was paused for mail service reauth
      for (const doc of pausedSearchItems.docs) {
        const data = doc.data();
        if (data.lastError?.includes("reconnect")) {
          await doc.ref.update({
            lastError: null,
          });
          console.log(`[MailService] Cleared error on precisionSearchQueue item: ${doc.id}`);
        }
      }

      // Resume pending workerRequests paused for reauth.
      const pausedWorkerRequests = await db
        .collection(`users/${userId}/workerRequests`)
        .where("status", "==", "pending")
        .where("pauseReason", "==", "reauth_required")
        .get();

      for (const doc of pausedWorkerRequests.docs) {
        await doc.ref.update({
          lastError: FieldValue.delete(),
          pauseReason: FieldValue.delete(),
          notBeforeAt: FieldValue.delete(),
          updatedAt: Timestamp.now(),
        });
        console.log(`[MailService] Resumed workerRequest after reauth: ${doc.id}`);
      }

      // Queue precision search for incomplete transactions that may have been
      // skipped while mail service was disconnected
      const existingSearch = await db
        .collection("precisionSearchQueue")
        .where("userId", "==", userId)
        .where("status", "in", ["pending", "processing"])
        .limit(1)
        .get();

      if (existingSearch.empty) {
        // Count incomplete transactions
        const incompleteCount = await db
          .collection("transactions")
          .where("userId", "==", userId)
          .where("isComplete", "==", false)
          .count()
          .get();

        const transactionsToProcess = incompleteCount.data().count;

        if (transactionsToProcess > 0) {
          const now = Timestamp.now();
          const queueItem = {
            userId,
            scope: "all_incomplete",
            triggeredBy: "mail_service_reconnected",
            triggeredByAuthor: {
              type: "system",
              userId: userId,
            },
            status: "pending",
            transactionsToProcess,
            transactionsProcessed: 0,
            transactionsWithMatches: 0,
            totalFilesConnected: 0,
            strategies: [
              "partner_files",
              "amount_files",
              "email_attachment",
              "email_invoice",
            ],
            currentStrategyIndex: 0,
            errors: [],
            retryCount: 0,
            maxRetries: 3,
            createdAt: now,
          };

          const docRef = await db.collection("precisionSearchQueue").add(queueItem);
          console.log(
            `[MailService] Queued precision search ${docRef.id} for ${transactionsToProcess} ` +
            `incomplete transactions after ${provider} reconnection`
          );
        }
      }

      // Create notification for user
      await db.collection("notifications").add({
        userId,
        type: "mail_service_reconnected",
        title: `${provider.charAt(0).toUpperCase() + provider.slice(1)} Reconnected`,
        message: `${afterData.email} is reconnected. Paused syncs will resume automatically.`,
        read: false,
        createdAt: Timestamp.now(),
      });
    } catch (error) {
      console.error(`[MailService] Error resuming paused queues:`, error);
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
  console.log(`[MailService] Querying transactions for userId: ${userId}`);

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

  console.log(`[MailService] Found ${earliestQuery.size} earliest, ${latestQuery.size} latest transactions`);

  if (earliestQuery.empty || latestQuery.empty) {
    console.log(`[MailService] No transactions found for user, will use fallback date range`);
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
