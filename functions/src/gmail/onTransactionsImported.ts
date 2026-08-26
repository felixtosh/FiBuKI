/**
 * Cloud Function: Gmail Sync After Transaction Import
 *
 * Triggered when an import record is created (CSV import completes).
 * Checks if the imported transactions fall outside the synced Gmail date range
 * and queues Gmail syncs for any gaps.
 *
 * This enables automatic invoice fetching for:
 * - Historical CSV imports (older transactions)
 * - Bank connection syncs that bring in new transactions
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { SYNCABLE_MAIL_PROVIDERS } from "../mail/constants";

const db = getFirestore();

// ============================================================================
// Types
// ============================================================================

interface EmailIntegration {
  id: string;
  userId: string;
  provider: string;
  email: string;
  isActive: boolean;
  needsReauth: boolean;
  initialSyncComplete?: boolean;
  syncedDateRange?: {
    from: Timestamp;
    to: Timestamp;
  };
}

interface ImportRecord {
  userId: string;
  sourceId: string;
  importedCount: number;
}

interface DateRange {
  from: Date;
  to: Date;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the date range of transactions from a specific import.
 */
async function getImportTransactionDateRange(
  importId: string,
  userId: string
): Promise<{ minDate: Date; maxDate: Date } | null> {
  const [earliestSnapshot, latestSnapshot] = await Promise.all([
    db.collection("transactions")
      .where("userId", "==", userId)
      .where("importJobId", "==", importId)
      .orderBy("date", "asc")
      .limit(1)
      .get(),
    db.collection("transactions")
      .where("userId", "==", userId)
      .where("importJobId", "==", importId)
      .orderBy("date", "desc")
      .limit(1)
      .get(),
  ]);

  if (earliestSnapshot.empty || latestSnapshot.empty) {
    return null;
  }

  const earliestDoc = earliestSnapshot.docs[0].data();
  const latestDoc = latestSnapshot.docs[0].data();

  const minDate = earliestDoc.date instanceof Timestamp
    ? earliestDoc.date.toDate()
    : new Date(earliestDoc.date);
  const maxDate = latestDoc.date instanceof Timestamp
    ? latestDoc.date.toDate()
    : new Date(latestDoc.date);

  return { minDate, maxDate };
}

/**
 * Get all active Gmail integrations for a user that have completed initial sync.
 */
async function getActiveGmailIntegrations(userId: string): Promise<EmailIntegration[]> {
  // Gmail and IMAP alike — the sync worker handles both; only the enqueue
  // side ever asked for Gmail alone (see SYNCABLE_MAIL_PROVIDERS).
  const snapshot = await db.collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("provider", "in", [...SYNCABLE_MAIL_PROVIDERS])
    .where("isActive", "==", true)
    .where("needsReauth", "==", false)
    .where("initialSyncComplete", "==", true)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as EmailIntegration[];
}

/**
 * Calculate sync gaps between import's transaction range and synced range.
 */
function calculateSyncGaps(
  transactionRange: { minDate: Date; maxDate: Date },
  syncedRange: { from: Date; to: Date } | null,
  bufferDays: number = 7
): DateRange[] {
  // Apply buffer to transaction range
  const transactionFrom = new Date(transactionRange.minDate);
  transactionFrom.setDate(transactionFrom.getDate() - bufferDays);

  const transactionTo = new Date(transactionRange.maxDate);
  transactionTo.setDate(transactionTo.getDate() + bufferDays);

  if (!syncedRange) {
    return [{ from: transactionFrom, to: transactionTo }];
  }

  const gaps: DateRange[] = [];

  // Gap BEFORE synced range (older transactions imported)
  if (transactionFrom < syncedRange.from) {
    gaps.push({
      from: transactionFrom,
      to: new Date(syncedRange.from.getTime() - 1),
    });
  }

  // Gap AFTER synced range (newer transactions imported)
  if (transactionTo > syncedRange.to) {
    gaps.push({
      from: new Date(syncedRange.to.getTime() + 1),
      to: transactionTo,
    });
  }

  return gaps;
}

/**
 * Check if there's already a pending/processing sync for an integration.
 */
async function hasPendingSync(integrationId: string): Promise<boolean> {
  const snapshot = await db.collection("gmailSyncQueue")
    .where("integrationId", "==", integrationId)
    .where("status", "in", ["pending", "processing"])
    .limit(1)
    .get();

  return !snapshot.empty;
}

// ============================================================================
// Firestore Trigger
// ============================================================================

/**
 * Triggered when an import record is created.
 * Queues Gmail syncs if imported transactions fall outside synced date range.
 */
export const onTransactionsImported = onDocumentCreated(
  {
    document: "imports/{importId}",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const importId = event.params.importId;
    const importData = event.data?.data() as ImportRecord | undefined;

    if (!importData) return;

    // Skip if no transactions were imported
    if (!importData.importedCount || importData.importedCount === 0) {
      console.log(`[GmailSyncAfterImport] No transactions imported for ${importId}, skipping`);
      return;
    }

    const userId = importData.userId;

    console.log(
      `[GmailSyncAfterImport] Import ${importId} created for user ${userId} ` +
      `with ${importData.importedCount} transactions`
    );

    // Get active Gmail integrations for this user
    const integrations = await getActiveGmailIntegrations(userId);

    if (integrations.length === 0) {
      console.log(`[GmailSyncAfterImport] No active Gmail integrations for user ${userId}`);
      return;
    }

    // Get the date range of the imported transactions
    const transactionRange = await getImportTransactionDateRange(importId, userId);

    if (!transactionRange) {
      console.log(`[GmailSyncAfterImport] Could not determine transaction date range for import ${importId}`);
      return;
    }

    console.log(
      `[GmailSyncAfterImport] Import date range: ${transactionRange.minDate.toISOString()} - ` +
      `${transactionRange.maxDate.toISOString()}`
    );

    const now = Timestamp.now();
    let totalQueued = 0;

    // Check each integration for gaps
    for (const integration of integrations) {
      // Skip if there's already a pending sync
      const hasPending = await hasPendingSync(integration.id);
      if (hasPending) {
        console.log(`[GmailSyncAfterImport] Integration ${integration.id} already has pending sync, skipping`);
        continue;
      }

      // Convert synced range
      const syncedRange = integration.syncedDateRange
        ? {
            from: integration.syncedDateRange.from.toDate(),
            to: integration.syncedDateRange.to.toDate(),
          }
        : null;

      // Calculate gaps
      const gaps = calculateSyncGaps(transactionRange, syncedRange);

      if (gaps.length === 0) {
        console.log(
          `[GmailSyncAfterImport] Integration ${integration.id} already covers import date range`
        );
        continue;
      }

      // Queue syncs for each gap
      for (const gap of gaps) {
        await db.collection("gmailSyncQueue").add({
          userId,
          integrationId: integration.id,
          type: "auto",
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
          // Track what triggered this sync
          triggeredBy: "import",
          triggeredByImportId: importId,
        });

        console.log(
          `[GmailSyncAfterImport] Queued auto sync for ${integration.email}: ` +
          `${gap.from.toISOString()} - ${gap.to.toISOString()}`
        );
        totalQueued++;
      }
    }

    console.log(
      `[GmailSyncAfterImport] Completed for import ${importId}: ${totalQueued} syncs queued`
    );
  }
);
