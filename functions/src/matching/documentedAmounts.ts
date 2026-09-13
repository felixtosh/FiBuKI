/**
 * What the Files already sitting on a Transaction explain (#239).
 *
 * The Firestore read behind Coverage, kept out of `coverage.ts` so that module
 * stays dependency-free for the detail panels. Both scorers that work from a
 * candidate set — the trigger that scores a File against Transactions, and the
 * callable behind the Connect dialog — resolve their Remainders through here,
 * so a pair cannot be judged against the full amount in one and against the
 * Remainder in the other.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { documentedAmountOf, filePaymentTotal } from "./coverage";

const db = getFirestore();

/** One File already connected to a candidate Transaction. */
export interface ConnectedFile {
  fileId: string;
  /**
   * What the bank was charged for it — `filePaymentTotal`, so a printed
   * Trinkgeld counts (#172). Null when the File has no extracted amount, which
   * contributes nothing to the documented amount.
   */
  payment: number | null;
  /**
   * The File's extracted date, or null when the Extraction found none. Read by
   * the same-day rule (#242); a File with no date is never same-day.
   */
  extractedDate: Timestamp | null;
}

/**
 * The Files already connected to each candidate, keyed by transaction id.
 * Transactions holding no Files are absent from the map.
 *
 * `excludeFileId` is the File being matched: it may already be connected to a
 * candidate, and a File cannot count towards the Remainder it is being scored
 * against.
 *
 * **Reads the `fileConnections` collection, not the transaction's `fileIds`.**
 * `fileConnections` is what `isTransactionCovered` read before this was
 * extracted (#239) and it stays the record of truth for "which Files sit on
 * this Transaction". `fileIds` is a denormalised copy maintained alongside it;
 * scoring off the copy would silently answer differently wherever the two
 * drift, and picking a new source of truth is not this ticket's decision to
 * make. The batching below exists because that read was per-candidate before.
 */
export async function loadConnectedFiles(
  transactionIds: string[],
  excludeFileId?: string
): Promise<Map<string, ConnectedFile[]>> {
  const fileIdsByTransaction = new Map<string, string[]>();
  const wantedFileIds = new Set<string>();

  // Firestore 'in' takes at most 30 values, so the candidates are chunked. One
  // query per 30 candidates, rather than the one query per candidate this read
  // used to cost.
  for (let i = 0; i < transactionIds.length; i += 30) {
    const chunk = transactionIds.slice(i, i + 30);
    const connections = await db
      .collection("fileConnections")
      .where("transactionId", "in", chunk)
      .get();

    for (const connection of connections.docs) {
      const { transactionId, fileId } = connection.data();
      // The File being scored cannot document the Remainder it is scored against.
      if (!transactionId || !fileId || fileId === excludeFileId) continue;
      const forTransaction = fileIdsByTransaction.get(transactionId) ?? [];
      if (forTransaction.includes(fileId)) continue; // duplicate connection rows
      forTransaction.push(fileId);
      fileIdsByTransaction.set(transactionId, forTransaction);
      wantedFileIds.add(fileId);
    }
  }

  const connected = new Map<string, ConnectedFile[]>();
  if (wantedFileIds.size === 0) return connected;

  // Firestore 'in' queries have a limit of 30, batch if needed
  const byFileId = new Map<string, ConnectedFile>();
  const allFileIds = Array.from(wantedFileIds);
  for (let i = 0; i < allFileIds.length; i += 30) {
    const batch = allFileIds.slice(i, i + 30);
    const filesSnapshot = await db
      .collection("files")
      .where("__name__", "in", batch)
      .get();

    for (const fileDoc of filesSnapshot.docs) {
      const fileData = fileDoc.data();
      byFileId.set(fileDoc.id, {
        fileId: fileDoc.id,
        // Against the bank line, so a printed Trinkgeld counts (#172).
        payment: filePaymentTotal(fileData.extractedAmount, fileData.extractedTipAmount),
        extractedDate: fileData.extractedDate ?? null,
      });
    }
  }

  for (const [transactionId, fileIds] of fileIdsByTransaction) {
    const files = fileIds
      .map((id) => byFileId.get(id))
      .filter((f): f is ConnectedFile => f !== undefined);
    if (files.length > 0) connected.set(transactionId, files);
  }

  return connected;
}

/**
 * Documented amount per transaction, from what `loadConnectedFiles` returned.
 * A Transaction whose Files explain nothing — every one of them without an
 * extracted amount — is absent, which callers read as zero: score against the
 * full amount.
 */
export function documentedAmountsOf(
  connected: Map<string, ConnectedFile[]>
): Map<string, number> {
  const documented = new Map<string, number>();
  for (const [transactionId, files] of connected) {
    const total = documentedAmountOf(files.map((f) => f.payment));
    if (total > 0) documented.set(transactionId, total);
  }
  return documented;
}

/**
 * Documented amount per transaction, for the candidates that hold any Files.
 * Transactions with no Files are absent from the map, which callers read as
 * zero — nothing connected, score against the full amount.
 *
 * The two reads above in one call, for the callers that need nothing else off
 * the connected Files.
 */
export async function loadDocumentedAmounts(
  transactionIds: string[],
  excludeFileId?: string
): Promise<Map<string, number>> {
  return documentedAmountsOf(await loadConnectedFiles(transactionIds, excludeFileId));
}
