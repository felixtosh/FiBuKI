import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { SYNCABLE_MAIL_PROVIDERS } from "../mail/constants";
import { forwardSyncGaps } from "../mail/syncWindow";

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
  isPaused?: boolean;
  initialSyncComplete?: boolean;
  lastSyncAt?: Timestamp;
  syncedDateRange?: {
    from: Timestamp;
    to: Timestamp;
  };
}

// ============================================================================
// Scheduled Daily Sync
// ============================================================================

/**
 * Daily sync for all mail integrations (Gmail and IMAP).
 * Runs at midnight Europe/Vienna time.
 *
 * For each active integration that has completed initial sync:
 * 1. Skips it while paused, needing re-auth, or already queued
 * 2. Queues one sync item from the end of the synced range to now
 *
 * Extracted from the scheduled handler so the self-host shim can exercise it
 * directly; the `onSchedule` export below only wraps it.
 */
export async function queueScheduledMailSyncs(
  now: Timestamp = Timestamp.now()
): Promise<{ queued: number; skipped: number }> {
  console.log("[GmailSync] Starting scheduled daily sync...");

  // Every active mailbox that has completed its initial sync — Gmail and
  // IMAP. The worker resolves the provider per queue item; filtering on
  // "gmail" here is what left IMAP mailboxes synced exactly once.
  const integrationsSnapshot = await db
    .collection("emailIntegrations")
    .where("provider", "in", [...SYNCABLE_MAIL_PROVIDERS])
    .where("isActive", "==", true)
    .where("needsReauth", "==", false)
    .where("initialSyncComplete", "==", true)
    .get();

  console.log(`[GmailSync] Found ${integrationsSnapshot.size} integrations to sync`);

  let queued = 0;
  let skipped = 0;

  for (const integrationDoc of integrationsSnapshot.docs) {
    const integration = { id: integrationDoc.id, ...integrationDoc.data() } as EmailIntegration;

    try {
      if (integration.isPaused) {
        console.log(`[GmailSync] Integration ${integration.id} is paused, skipping`);
        skipped++;
        continue;
      }

      // Check if there's already a pending/processing sync for this integration
      const existingSync = await db
        .collection("gmailSyncQueue")
        .where("integrationId", "==", integration.id)
        .where("status", "in", ["pending", "processing"])
        .limit(1)
        .get();

      if (!existingSync.empty) {
        console.log(`[GmailSync] Integration ${integration.id} already has a pending sync, skipping`);
        skipped++;
        continue;
      }

      // Forward from the synced range to now (#103).

      // Convert synced range timestamps to dates
      const syncedRange = integration.syncedDateRange
        ? {
            from: integration.syncedDateRange.from.toDate(),
            to: integration.syncedDateRange.to.toDate(),
          }
        : null;

      const gaps = forwardSyncGaps(syncedRange, now.toDate());

      if (gaps.length === 0) {
        console.log(`[GmailSync] Integration ${integration.id} fully synced, skipping`);
        skipped++;
        continue;
      }

      // Create sync queue items for each gap
      for (const gap of gaps) {
        await db.collection("gmailSyncQueue").add({
          userId: integration.userId,
          integrationId: integration.id,
          type: "scheduled",
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

        console.log(
          `[GmailSync] Queued scheduled sync for ${integration.email}: ` +
          `${gap.from.toISOString()} - ${gap.to.toISOString()}`
        );
        queued++;
      }
    } catch (error) {
      console.error(`[GmailSync] Error queuing sync for ${integration.id}:`, error);
    }
  }

  console.log(`[GmailSync] Scheduled sync complete: ${queued} queued, ${skipped} skipped`);
  return { queued, skipped };
}

export const scheduledGmailSync = onSchedule(
  {
    schedule: "0 0 * * *", // Midnight
    timeZone: "Europe/Vienna",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 300,
  },
  async () => {
    await queueScheduledMailSyncs();
  }
);
