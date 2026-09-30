/**
 * Cloud Function: mail search after a transaction Import
 *
 * Triggered when an import record is created (CSV import completes). When the
 * user has a connected mailbox, queues per-Transaction mail search for the
 * incomplete Transactions.
 *
 * Until #103 this queued a bulk mail Sync over every gap between the imported
 * date range and the mailbox's synced range, so importing older statements
 * pulled that whole span of mail. Per-Transaction search finds the receipts
 * the imported lines need without it; mail newer than the synced range is
 * still fetched forward by the scheduled Sync.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { SYNCABLE_MAIL_PROVIDERS } from "../mail/constants";
import { queueIncompleteTransactionSearch } from "../precision-search/queueIncompleteSearch";

interface ImportRecord {
  userId: string;
  sourceId?: string;
  importedCount: number;
}

/** Whether the user has a mailbox the search can use. */
async function hasConnectedMailbox(db: FirebaseFirestore.Firestore, userId: string): Promise<boolean> {
  // Gmail and IMAP alike (see SYNCABLE_MAIL_PROVIDERS).
  const snapshot = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("provider", "in", [...SYNCABLE_MAIL_PROVIDERS])
    .where("isActive", "==", true)
    .where("needsReauth", "==", false)
    .where("initialSyncComplete", "==", true)
    .limit(1)
    .get();
  return !snapshot.empty;
}

/** The trigger's body, exported so the self-host suite can drive it. */
export async function handleTransactionsImported(
  importId: string,
  importData: ImportRecord
): Promise<void> {
  if (!importData.importedCount) {
    console.log(`[MailSearchAfterImport] No transactions imported for ${importId}, skipping`);
    return;
  }

  const db = getFirestore();
  const userId = importData.userId;
  if (!(await hasConnectedMailbox(db, userId))) {
    console.log(`[MailSearchAfterImport] No connected mailbox for user ${userId}`);
    return;
  }

  await queueIncompleteTransactionSearch(db, userId, "import", { triggeredByImportId: importId });
}

export const onTransactionsImported = onDocumentCreated(
  {
    document: "imports/{importId}",
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const importData = event.data?.data() as ImportRecord | undefined;
    if (!importData) return;
    await handleTransactionsImported(event.params.importId, importData);
  }
);
