/**
 * Trigger precision search when Gmail sync completes
 *
 * When a Gmail sync queue item transitions to "completed" status,
 * this trigger queues a precision search for all incomplete transactions.
 */

import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { queueIncompleteTransactionSearch } from "./queueIncompleteSearch";

const db = getFirestore();

/**
 * Triggered when Gmail sync completes.
 * Queues precision search for all incomplete transactions.
 */
export const onGmailSyncComplete = onDocumentUpdated(
  {
    document: "gmailSyncQueue/{queueId}",
    region: "europe-west1",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) return;

    // Only trigger when status changes to "completed"
    if (before.status === "completed" || after.status !== "completed") {
      return;
    }

    const userId = after.userId;
    const gmailSyncQueueId = event.params.queueId;
    const filesCreated = after.filesCreated || 0;

    console.log(
      `[PrecisionSearch] Gmail sync ${gmailSyncQueueId} completed with ${filesCreated} files`
    );

    // Note: We no longer skip when filesCreated === 0 because:
    // 1. email_invoice strategy can find HTML invoices even without attachments
    // 2. This is the entry point for transactions that were skipped earlier
    //    due to no email integration being connected
    // 3. Since #103 a first Sync covers today only, so this search is what
    //    finds receipts for every older Transaction
    await queueIncompleteTransactionSearch(db, userId, "gmail_sync", { gmailSyncQueueId });
  }
);
