/**
 * Make a connected mailbox ready for receipt search (#103).
 *
 * FiBuKI no longer syncs mailboxes. A bulk Sync downloaded every
 * invoice-looking attachment in a date window, most of which no Transaction
 * ever needed, and it overloaded the system. Instead the per-Transaction
 * precision search asks the mailbox for the one receipt an undocumented
 * Transaction is missing (the email_attachment and email_invoice strategies).
 *
 * So connecting, reconnecting or resuming a mailbox only marks it ready
 * (`initialSyncComplete`, which the status UI and the search worker read) and
 * queues that search for the user's incomplete Transactions.
 *
 * No `firebase-functions` import: the web container's connect and resume
 * routes call this too.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { queueIncompleteTransactionSearch } from "../precision-search/queueIncompleteSearch";

export interface ActivateMailIntegrationParams {
  integrationId: string;
  userId: string;
  /** Only used for the user-facing notification. */
  email: string;
  /** Why the mailbox is being activated, recorded on the search it queues. */
  reason: "mail_service_connected" | "mail_service_reconnected" | "mail_service_resumed";
  /** Leave out the notification, e.g. when the caller shows its own. */
  notify?: boolean;
}

export interface ActivateMailIntegrationResult {
  searchQueued: boolean;
  transactionsToProcess: number;
}

export async function activateMailIntegration(
  params: ActivateMailIntegrationParams,
  db: FirebaseFirestore.Firestore = getFirestore()
): Promise<ActivateMailIntegrationResult> {
  const { integrationId, userId, email, reason, notify = true } = params;
  const now = Timestamp.now();

  await db.collection("emailIntegrations").doc(integrationId).update({
    initialSyncComplete: true,
    initialSyncStartedAt: FieldValue.delete(),
    isPaused: false,
    updatedAt: now,
  });

  const search = await queueIncompleteTransactionSearch(db, userId, reason, { integrationId });

  if (notify) {
    await db.collection(`users/${userId}/notifications`).add({
      userId,
      type: reason === "mail_service_connected" ? "mail_service_connected" : "mail_service_reconnected",
      title: "Mailbox Connected",
      message: `${email} is connected. FiBuKI searches it for the receipts your open transactions are missing.`,
      readAt: null,
      createdAt: now,
    });
  }

  return { searchQueued: search.queued, transactionsToProcess: search.transactionsToProcess };
}
