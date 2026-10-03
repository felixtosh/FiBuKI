/**
 * The payee rule against stored records (#550, ADR-0011): loads every File on a
 * Transaction and asks `payeeFillFromFiles` whether its empty Partner is filled.
 *
 * Every server writer that used to sync a File's Partner onto its Transaction
 * goes through here: the connect step, the tool surface's connect, auto-connect
 * and the File Partner match. One answer, whichever of them runs last.
 */

import { payeeFillFromFiles, type FilePartnerRef, type PayeeFill } from "./payeeRule";

export interface PayeeFillOptions {
  /** A File joining the Transaction in the caller's pending write. */
  connectingFileId?: string;
  /** Files whose state the caller already holds, newer than what is stored. */
  known?: ReadonlyMap<string, FilePartnerRef>;
}

export async function payeeFillForTransaction(
  db: FirebaseFirestore.Firestore,
  userId: string,
  transaction: FirebaseFirestore.DocumentData,
  options: PayeeFillOptions = {}
): Promise<PayeeFill | null> {
  // A set Partner is never changed by a File, so there is nothing to load.
  if (transaction.partnerId) return null;

  const fileIds = new Set<string>(
    Array.isArray(transaction.fileIds)
      ? transaction.fileIds.filter((id: unknown): id is string => typeof id === "string")
      : []
  );
  if (options.connectingFileId) fileIds.add(options.connectingFileId);
  if (fileIds.size === 0) return null;

  const files: FilePartnerRef[] = [];
  for (const fileId of fileIds) {
    const held = options.known?.get(fileId);
    if (held) {
      files.push(held);
      continue;
    }
    const snap = await db.collection("files").doc(fileId).get();
    const data = snap.data();
    if (!snap.exists || !data || data.userId !== userId || data.deletedAt) continue;
    files.push(data as FilePartnerRef);
  }

  return payeeFillFromFiles(transaction, files);
}
