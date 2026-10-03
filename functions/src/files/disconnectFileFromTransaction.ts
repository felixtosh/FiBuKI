/**
 * Disconnect a file from a transaction
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import {
  partnerRevertForRemovedConnection,
  rematchRevertedTransactions,
} from "../matching/partnerProvenance";

interface DisconnectFileRequest {
  fileId: string;
  transactionId: string;
  /** If true, adds the file to transaction's rejectedFileIds to prevent auto-reconnection */
  rejectFile?: boolean;
}

interface DisconnectFileResponse {
  success: boolean;
}

interface PartnerFileSourcePattern {
  sourceType: string;
  pattern: string;
  integrationId?: string | null;
  resultType?: string;
  confidence: number;
  usageCount: number;
  sourceTransactionIds?: string[];
}

/**
 * A removed File Connection that a search found counts one use less on the
 * Partner's learned file source pattern; a pattern with no use left goes.
 * Best effort, after the commit, like the learning on connect.
 */
async function decrementFileSourcePattern(
  db: FirebaseFirestore.Firestore,
  userId: string,
  partnerId: string,
  transactionId: string,
  connection: FirebaseFirestore.DocumentData
): Promise<void> {
  const sourceType = connection.sourceType as string | undefined;
  const searchPattern = connection.searchPattern as string | undefined;
  if (!sourceType || !searchPattern) return;

  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();
  if (!partnerSnap.exists || partnerSnap.data()?.userId !== userId) return;

  const patterns = (partnerSnap.data()!.fileSourcePatterns || []) as PartnerFileSourcePattern[];
  const index = patterns.findIndex((p) => {
    if (p.sourceType !== sourceType) return false;
    if ((p.pattern || "").toLowerCase() !== searchPattern.toLowerCase()) return false;
    if (sourceType === "gmail" && (p.integrationId ?? null) !== (connection.gmailIntegrationId ?? null)) {
      return false;
    }
    if (connection.resultType && p.resultType && p.resultType !== connection.resultType) return false;
    return true;
  });
  if (index < 0) return;

  const now = Timestamp.now();
  const target = patterns[index];
  const remainingTxIds = (target.sourceTransactionIds || []).filter((id) => id !== transactionId);
  const nextUsageCount = Math.max(0, target.usageCount - 1);
  const next =
    nextUsageCount === 0 || remainingTxIds.length === 0
      ? patterns.filter((_, i) => i !== index)
      : patterns.map((p, i) =>
          i !== index
            ? p
            : {
                ...p,
                usageCount: nextUsageCount,
                confidence: Math.max(50, p.confidence - 5),
                sourceTransactionIds: remainingTxIds.slice(-20),
                lastUsedAt: now,
              }
        );

  await partnerRef.update({
    fileSourcePatterns: next,
    fileSourcePatternsUpdatedAt: now,
    updatedAt: now,
  });
}

/**
 * The disconnect itself, shared by the callable and the tool surface (#584).
 * Takes the File Connection apart, derives a Partner the payee rule filled
 * from the remaining Files, lowers the learned file source pattern's use, and matches a
 * Transaction left without a Partner again from its bank data.
 */
export async function performDisconnectFile(
  db: FirebaseFirestore.Firestore,
  userId: string,
  request: DisconnectFileRequest
): Promise<DisconnectFileResponse> {
  const { fileId, transactionId, rejectFile = false } = request;

  if (!fileId || !transactionId) {
    throw new HttpsError("invalid-argument", "fileId and transactionId are required");
  }

  // Verify file ownership
  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists) {
    throw new HttpsError("not-found", "File not found");
  }

  const fileData = fileSnap.data()!;
  if (fileData.userId !== userId) {
    throw new HttpsError("permission-denied", "File access denied");
  }

  // Verify transaction ownership
  const transactionRef = db.collection("transactions").doc(transactionId);
  const transactionSnap = await transactionRef.get();

  if (!transactionSnap.exists) {
    throw new HttpsError("not-found", "Transaction not found");
  }

  const transactionData = transactionSnap.data()!;
  if (transactionData.userId !== userId) {
    throw new HttpsError("permission-denied", "Transaction access denied");
  }

  // Find the connection document
  const connectionQuery = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("transactionId", "==", transactionId)
    .where("userId", "==", userId)
    .limit(1)
    .get();
  const connectionData = !connectionQuery.empty ? connectionQuery.docs[0].data() : null;

  // Check if this is the last file and transaction has no noReceiptCategory
  const currentFileIds: string[] = transactionData.fileIds || [];
  const willHaveNoFiles = currentFileIds.length <= 1;
  const hasNoReceiptCategory = !!transactionData.noReceiptCategoryId;

  const revert = await partnerRevertForRemovedConnection(db, userId, {
    fileId,
    fileData,
    transactionId,
    txData: transactionData,
    remainingFileIds: currentFileIds.filter((id) => id !== fileId),
  });

  const now = Timestamp.now();
  const batch = db.batch();

  // 1. Delete junction document if it exists
  if (!connectionQuery.empty) {
    batch.delete(connectionQuery.docs[0].ref);
  }

  // 2. Update file's transactionIds array
  batch.update(fileRef, {
    transactionIds: FieldValue.arrayRemove(transactionId),
    updatedAt: now,
  });

  // 3. Update transaction's fileIds array and potentially mark incomplete
  const fileName = fileData.fileName || null;
  const transactionUpdate: Record<string, unknown> = {
    ...revert.transaction,
    fileIds: FieldValue.arrayRemove(fileId),
    updatedAt: now,
    automationHistory: FieldValue.arrayUnion(
      {
        type: "file_disconnected",
        ranAt: now,
        status: "completed",
        actor: "manual" as const,
        level: "decision" as const,
        fileId,
        fileName,
        summary: `File "${fileName || fileId}" disconnected`,
      },
      ...revert.transactionActivity
    ),
  };

  // Mark incomplete only if no files remain AND no no-receipt category
  if (willHaveNoFiles && !hasNoReceiptCategory) {
    transactionUpdate.isComplete = false;
  }

  // If rejecting, add to both rejectedFileIds (legacy) and rejectedFiles (with timestamp)
  if (rejectFile) {
    transactionUpdate.rejectedFileIds = FieldValue.arrayUnion(fileId);
    transactionUpdate.rejectedFiles = FieldValue.arrayUnion({
      fileId,
      rejectedAt: now,
      matchConfidence: connectionData?.matchConfidence ?? null,
    });
  }

  batch.update(transactionRef, transactionUpdate);

  await batch.commit();

  console.log(`[disconnectFileFromTransaction] Disconnected file ${fileId} from transaction ${transactionId}`);

  // The pattern was learned on the Partner the pair held, before any revert.
  const patternPartnerId = transactionData.partnerId ?? fileData.partnerId ?? null;
  if (connectionData && patternPartnerId) {
    try {
      await decrementFileSourcePattern(db, userId, patternPartnerId, transactionId, connectionData);
    } catch (err) {
      console.error("[disconnectFileFromTransaction] Failed to decrement file source pattern:", err);
    }
  }

  await rematchRevertedTransactions(userId, [revert.rematchTransactionId]);

  return { success: true };
}

export const disconnectFileFromTransactionCallable = createCallable<
  DisconnectFileRequest,
  DisconnectFileResponse
>({ name: "disconnectFileFromTransaction" }, (ctx, request) =>
  performDisconnectFile(ctx.db, ctx.userId, request)
);
