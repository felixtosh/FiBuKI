import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  Timestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  GmailSyncQueueItem,
  GmailSyncStatus,
  GmailSyncType,
  CreateSyncQueueData,
  GmailSyncResult,
} from "@/types/gmail-sync";
import { EmailIntegration } from "@/types/email-integration";
import { toDateSafe } from "@/lib/utils";

const GMAIL_SYNC_QUEUE_COLLECTION = "gmailSyncQueue";
const EMAIL_INTEGRATIONS_COLLECTION = "emailIntegrations";
const TRANSACTIONS_COLLECTION = "transactions";
const FILES_COLLECTION = "files";

// ============ Sync Queue Operations ============

/**
 * Queue a Gmail sync for an integration.
 * Creates a new queue item for the background processor to handle.
 *
 * @returns The queue item ID
 */
export async function queueGmailSync(
  ctx: OperationsContext,
  data: CreateSyncQueueData
): Promise<string> {
  const now = Timestamp.now();

  const queueItem: Omit<GmailSyncQueueItem, "id"> = {
    userId: ctx.userId,
    integrationId: data.integrationId,
    type: data.type,
    status: "pending",
    dateFrom: Timestamp.fromDate(data.dateFrom),
    dateTo: Timestamp.fromDate(data.dateTo),
    emailsProcessed: 0,
    filesCreated: 0,
    attachmentsSkipped: 0,
    errors: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: now,
  };

  const docRef = await addDoc(
    collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
    queueItem
  );

  console.log(
    `[GmailSync] Queued ${data.type} sync for integration ${data.integrationId}: ${docRef.id}`
  );

  return docRef.id;
}

/**
 * Get the next pending sync queue item for processing.
 * Returns the oldest pending item, optionally filtered by user.
 */
export async function getNextSyncQueueItem(
  ctx: OperationsContext,
  options?: { userId?: string }
): Promise<GmailSyncQueueItem | null> {
  let q = query(
    collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
    where("status", "==", "pending"),
    orderBy("createdAt", "asc"),
    limit(1)
  );

  if (options?.userId) {
    q = query(
      collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
      where("status", "==", "pending"),
      where("userId", "==", options.userId),
      orderBy("createdAt", "asc"),
      limit(1)
    );
  }

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as GmailSyncQueueItem;
}

/**
 * Get a sync queue item by ID
 */
export async function getSyncQueueItem(
  ctx: OperationsContext,
  queueId: string
): Promise<GmailSyncQueueItem | null> {
  const docRef = doc(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION, queueId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (data.userId !== ctx.userId) return null;

  return { id: snapshot.id, ...data } as GmailSyncQueueItem;
}

/**
 * Update a sync queue item's status and progress
 */
export async function updateSyncQueueItem(
  ctx: OperationsContext,
  queueId: string,
  updates: Partial<{
    status: GmailSyncStatus;
    nextPageToken: string | null;
    currentPage: number;
    emailsProcessed: number;
    filesCreated: number;
    attachmentsSkipped: number;
    errors: string[];
    lastError: string;
    retryCount: number;
    startedAt: Timestamp;
    completedAt: Timestamp;
  }>
): Promise<void> {
  const docRef = doc(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION, queueId);
  await updateDoc(docRef, updates);
}

/**
 * Mark a sync queue item as started (processing)
 */
export async function startSyncQueueItem(
  ctx: OperationsContext,
  queueId: string
): Promise<void> {
  await updateSyncQueueItem(ctx, queueId, {
    status: "processing",
    startedAt: Timestamp.now(),
  });
}

/**
 * Complete a sync queue item with result
 */
export async function completeSyncQueueItem(
  ctx: OperationsContext,
  queueId: string,
  result: GmailSyncResult
): Promise<void> {
  const updates: Record<string, unknown> = {
    status: result.success ? "completed" : "failed",
    emailsProcessed: result.emailsSearched,
    filesCreated: result.filesCreated,
    attachmentsSkipped: result.attachmentsSkipped,
    completedAt: Timestamp.now(),
  };

  if (result.error) {
    updates.lastError = result.error;
  }

  await updateSyncQueueItem(ctx, queueId, updates);

  console.log(
    `[GmailSync] Completed queue ${queueId}: ${result.filesCreated} files created, ${result.emailsSearched} emails searched`
  );
}

/**
 * Mark a sync queue item for retry
 */
export async function retrySyncQueueItem(
  ctx: OperationsContext,
  queueId: string,
  error: string
): Promise<boolean> {
  const item = await getSyncQueueItem(ctx, queueId);
  if (!item) return false;

  if (item.retryCount >= item.maxRetries) {
    // Max retries exceeded, mark as failed
    await updateSyncQueueItem(ctx, queueId, {
      status: "failed",
      lastError: `Max retries exceeded: ${error}`,
      completedAt: Timestamp.now(),
    });
    return false;
  }

  // Increment retry count and reset to pending
  await updateSyncQueueItem(ctx, queueId, {
    status: "pending",
    retryCount: item.retryCount + 1,
    lastError: error,
  });

  return true;
}

// ============ Transaction Date Range ============

/**
 * Get the date range of the user's transactions.
 * Used to limit invoice search to relevant dates.
 *
 * @returns Object with minDate and maxDate, or null if no transactions
 */
export async function getTransactionDateRange(
  ctx: OperationsContext
): Promise<{ minDate: Date; maxDate: Date } | null> {
  // Get earliest transaction
  const earliestQuery = query(
    collection(ctx.db, TRANSACTIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    orderBy("date", "asc"),
    limit(1)
  );

  // Get latest transaction
  const latestQuery = query(
    collection(ctx.db, TRANSACTIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    orderBy("date", "desc"),
    limit(1)
  );

  const [earliestSnapshot, latestSnapshot] = await Promise.all([
    getDocs(earliestQuery),
    getDocs(latestQuery),
  ]);

  if (earliestSnapshot.empty || latestSnapshot.empty) {
    return null;
  }

  const earliestDoc = earliestSnapshot.docs[0].data();
  const latestDoc = latestSnapshot.docs[0].data();

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

// ============ Sync Gap Detection ============

/**
 * Date range with buffer applied for invoice search
 */
export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Calculate sync gaps between transaction date range and already-synced range.
 * Returns date ranges that need to be synced.
 *
 * @param transactionRange - The current min/max dates of user's transactions
 * @param syncedRange - The date range already synced (from integration.syncedDateRange)
 * @param bufferDays - Days to add before/after transaction range (default: 7)
 * @returns Array of date ranges that need to be synced (0-2 ranges)
 */
export function calculateSyncGaps(
  transactionRange: { minDate: Date; maxDate: Date } | null,
  syncedRange: { from: Date; to: Date } | null,
  bufferDays: number = 7
): DateRange[] {
  // No transactions - nothing to sync
  if (!transactionRange) {
    return [];
  }

  // Apply buffer to transaction range
  const transactionFrom = new Date(transactionRange.minDate);
  transactionFrom.setDate(transactionFrom.getDate() - bufferDays);

  const transactionTo = new Date(transactionRange.maxDate);
  transactionTo.setDate(transactionTo.getDate() + bufferDays);

  // If never synced, sync the full transaction range
  if (!syncedRange) {
    return [{ from: transactionFrom, to: transactionTo }];
  }

  const gaps: DateRange[] = [];

  // Check for gap BEFORE synced range (older transactions imported)
  if (transactionFrom < syncedRange.from) {
    gaps.push({
      from: transactionFrom,
      to: new Date(syncedRange.from.getTime() - 1), // Day before synced range starts
    });
  }

  // Check for gap AFTER synced range (newer transactions or just time passing)
  if (transactionTo > syncedRange.to) {
    gaps.push({
      from: new Date(syncedRange.to.getTime() + 1), // Day after synced range ends
      to: transactionTo,
    });
  }

  return gaps;
}

/**
 * Get the date range to sync for a manual or scheduled sync.
 * Considers existing synced range and finds gaps.
 *
 * @returns Array of date ranges to sync, or empty if fully synced
 */
export async function getSyncDateRanges(
  ctx: OperationsContext,
  integrationId: string
): Promise<DateRange[]> {
  // Get integration to read syncedDateRange
  const integrationDoc = await getDoc(
    doc(ctx.db, EMAIL_INTEGRATIONS_COLLECTION, integrationId)
  );

  if (!integrationDoc.exists()) {
    throw new Error(`Integration ${integrationId} not found`);
  }

  const integration = integrationDoc.data() as EmailIntegration;

  // Get current transaction date range
  const transactionRange = await getTransactionDateRange(ctx);

  // Convert Firestore Timestamps to Dates if present
  const syncedRange = integration.syncedDateRange
    ? {
        from: integration.syncedDateRange.from.toDate(),
        to: integration.syncedDateRange.to.toDate(),
      }
    : null;

  return calculateSyncGaps(transactionRange, syncedRange);
}

// ============ Integration Sync Status ============

/**
 * Update sync status on an email integration
 */
export async function updateIntegrationSyncStatus(
  ctx: OperationsContext,
  integrationId: string,
  status: {
    lastSyncAt?: Timestamp;
    lastSyncStatus?: "success" | "partial" | "failed";
    lastSyncError?: string | null;
    lastSyncFileCount?: number;
    initialSyncComplete?: boolean;
    initialSyncStartedAt?: Timestamp;
  }
): Promise<void> {
  const docRef = doc(ctx.db, EMAIL_INTEGRATIONS_COLLECTION, integrationId);

  // Verify ownership
  const snapshot = await getDoc(docRef);
  if (!snapshot.exists() || snapshot.data().userId !== ctx.userId) {
    throw new Error(`Integration ${integrationId} not found or access denied`);
  }

  await updateDoc(docRef, {
    ...status,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Mark initial sync as started
 */
export async function markInitialSyncStarted(
  ctx: OperationsContext,
  integrationId: string
): Promise<void> {
  await updateIntegrationSyncStatus(ctx, integrationId, {
    initialSyncStartedAt: Timestamp.now(),
  });
}

/**
 * Mark initial sync as complete
 */
export async function markInitialSyncComplete(
  ctx: OperationsContext,
  integrationId: string,
  fileCount: number
): Promise<void> {
  await updateIntegrationSyncStatus(ctx, integrationId, {
    initialSyncComplete: true,
    lastSyncAt: Timestamp.now(),
    lastSyncStatus: "success",
    lastSyncFileCount: fileCount,
  });
}

// ============ Deduplication ============

/**
 * Check if a Gmail attachment has already been imported.
 * Uses gmailMessageId + gmailAttachmentId for deduplication.
 */
export async function isGmailAttachmentImported(
  ctx: OperationsContext,
  gmailMessageId: string,
  attachmentId: string
): Promise<boolean> {
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("gmailMessageId", "==", gmailMessageId),
    where("gmailAttachmentId", "==", attachmentId),
    limit(1)
  );

  const snapshot = await getDocs(q);
  return !snapshot.empty;
}

/**
 * Check if a file with the given content hash already exists
 */
export async function isContentHashDuplicate(
  ctx: OperationsContext,
  contentHash: string
): Promise<boolean> {
  const q = query(
    collection(ctx.db, FILES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("contentHash", "==", contentHash),
    limit(1)
  );

  const snapshot = await getDocs(q);
  return !snapshot.empty;
}

// ============ Integration Listing for Sync ============

/**
 * List all active Gmail integrations that need syncing.
 * Used by the scheduled sync function.
 *
 * Returns integrations that:
 * - Are active (isActive = true)
 * - Are Gmail provider
 * - Don't need re-auth
 * - Have completed initial sync
 */
export async function listIntegrationsForSync(
  ctx: OperationsContext
): Promise<EmailIntegration[]> {
  const q = query(
    collection(ctx.db, EMAIL_INTEGRATIONS_COLLECTION),
    where("provider", "==", "gmail"),
    where("isActive", "==", true),
    where("needsReauth", "==", false),
    where("initialSyncComplete", "==", true)
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as EmailIntegration[];
}

// Stale threshold: 10 minutes for pending items
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Check if a queue item is stale (pending for too long)
 */
function isQueueItemStale(data: { status: string; createdAt?: { toDate: () => Date } }): boolean {
  if (data.status !== "pending") return false;
  const createdAt = toDateSafe(data.createdAt);
  if (!createdAt) return false;
  return Date.now() - createdAt.getTime() > STALE_THRESHOLD_MS;
}

/**
 * Check if a sync is already in progress for an integration
 * Ignores stale items (pending > 10 minutes)
 */
export async function hasPendingSync(
  ctx: OperationsContext,
  integrationId: string
): Promise<boolean> {
  const q = query(
    collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
    where("integrationId", "==", integrationId),
    where("status", "in", ["pending", "processing"]),
    limit(5) // Get a few to check for non-stale ones
  );

  const snapshot = await getDocs(q);

  // Check if any non-stale items exist
  for (const doc of snapshot.docs) {
    const data = doc.data() as { status: string; createdAt?: { toDate: () => Date } };
    if (!isQueueItemStale(data)) {
      return true; // Found a valid (non-stale) pending/processing item
    }
  }

  return false;
}

/**
 * Clean up stale queue items for an integration
 * Returns the number of items cleaned up
 */
export async function cleanupStaleQueueItems(
  ctx: OperationsContext,
  integrationId: string
): Promise<number> {
  const q = query(
    collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
    where("integrationId", "==", integrationId),
    where("status", "==", "pending")
  );

  const snapshot = await getDocs(q);
  let cleaned = 0;

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data() as { status: string; createdAt?: { toDate: () => Date } };
    if (isQueueItemStale(data)) {
      // Mark as failed instead of deleting to preserve history
      await updateDoc(doc(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION, docSnap.id), {
        status: "failed",
        lastError: "Sync timed out (stale queue item)",
        completedAt: Timestamp.now(),
      });
      cleaned++;
      console.log(`[GmailSync] Cleaned up stale queue item: ${docSnap.id}`);
    }
  }

  return cleaned;
}

/**
 * Get active sync queue items for a user
 */
export async function getActiveSyncs(
  ctx: OperationsContext
): Promise<GmailSyncQueueItem[]> {
  const q = query(
    collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
    where("userId", "==", ctx.userId),
    where("status", "in", ["pending", "processing"]),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as GmailSyncQueueItem[];
}

// ============ Pause/Resume Operations ============

/**
 * Pause any active sync queue items for an integration.
 * Marks pending/processing items as "paused".
 *
 * @returns The paused queue item with its current progress, or null if no active sync
 */
export async function pauseActiveSyncForIntegration(
  ctx: OperationsContext,
  integrationId: string
): Promise<GmailSyncQueueItem | null> {
  const q = query(
    collection(ctx.db, GMAIL_SYNC_QUEUE_COLLECTION),
    where("integrationId", "==", integrationId),
    where("status", "in", ["pending", "processing"]),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    return null;
  }

  const preferredDoc = snapshot.docs.find((docSnap) => docSnap.data().status === "processing")
    || snapshot.docs[0];
  const queueItem = { id: preferredDoc.id, ...preferredDoc.data() } as GmailSyncQueueItem;

  const pausedAt = Timestamp.now();
  await Promise.all(
    snapshot.docs.map((docSnap) => updateDoc(docSnap.ref, {
      status: "paused",
      completedAt: pausedAt,
    }))
  );

  console.log(
    `[GmailSync] Paused sync ${queueItem.id} for integration ${integrationId} ` +
    `(${queueItem.filesCreated} files, ${queueItem.emailsProcessed} emails)`
  );

  return queueItem;
}
