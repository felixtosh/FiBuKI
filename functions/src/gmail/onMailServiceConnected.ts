import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { activateMailIntegration } from "../mail/activateMailIntegration";

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
 * Gmail setup: mark the mailbox ready and search it per Transaction (#103).
 * No Sync is queued; see mail/activateMailIntegration.ts.
 */
async function setupGmailIntegration(
  _event: Parameters<Parameters<typeof onDocumentCreated>[1]>[0],
  data: EmailIntegration,
  integrationId: string,
  userId: string
): Promise<void> {
  await activateMailIntegration({ integrationId, userId, email: data.email, reason: "mail_service_connected" });
  console.log(`[MailService] Gmail integration activated: ${data.email}`);
}

/**
 * IMAP setup, same as Gmail. The connect route also activates the mailbox,
 * because on a self-host deployment this trigger does not see a write made in
 * the web container; activating twice is harmless (the search is deduped).
 */
async function setupImapIntegration(
  _event: Parameters<Parameters<typeof onDocumentCreated>[1]>[0],
  data: EmailIntegration,
  integrationId: string,
  userId: string
): Promise<void> {
  await activateMailIntegration({ integrationId, userId, email: data.email, reason: "mail_service_connected" });
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

    console.log(`[MailService] ${provider} reconnected: ${afterData.email}`);

    try {
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

      // Mark the mailbox ready again and search it for the receipts that
      // were missed while it was disconnected (#103: no Sync is resumed).
      await activateMailIntegration({
        integrationId,
        userId,
        email: afterData.email,
        reason: "mail_service_reconnected",
      });
    } catch (error) {
      console.error(`[MailService] Error resuming paused queues:`, error);
    }
  }
);

