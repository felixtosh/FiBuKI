/**
 * Reading the rejection list a transaction carries (fork #102).
 *
 * disconnectFileFromTransaction writes two shapes of the same fact: the legacy
 * `rejectedFileIds` string array and the richer `rejectedFiles` records
 * (rejectedAt, matchConfidence). Every path that proposes or auto-connects a
 * file-to-transaction pair, and every path that learns from past rejections,
 * reads both through here, so one rejection cannot half-hold.
 *
 * This module owns the answer to "does this transaction still reject this
 * file?". It is the transaction-side mirror of matching/dismissedTransactions,
 * which owns the same question for the file-side pair, and it takes the same
 * position on undo (fork #95): un-rejecting stamps the record rather than
 * deleting it, so a reader that only checks for the record's presence would go
 * on suppressing a pair the user took back — which is exactly the defect #102
 * was filed for.
 */

/** The two fields a transaction document uses to record rejected files. */
export interface TransactionRejectionFields {
  rejectedFileIds?: unknown;
  rejectedFiles?: unknown;
}

/**
 * True when a `rejectedFiles` record still suppresses its pair.
 *
 * Undo keeps the record and stamps it `unrejectedAt`: the note is the point, so
 * the learning export and a later sweep can still see this pair was rejected,
 * at what confidence, and then restored. Suppression and history are two
 * different questions about the same record, and this is the one that decides
 * suppression.
 *
 * `rejectedFiles` is a log, not a set: the writer stamps each record with its
 * own `rejectedAt`, so re-rejecting appends a second, unstamped record and one
 * active record among reversed ones still suppresses.
 *
 * Takes `unknown` for the same reason the readers below do — callers hand it a
 * raw Firestore record whose type declares none of these fields.
 */
export function isActiveRejection(record: unknown): boolean {
  const unrejectedAt = (record as { unrejectedAt?: unknown } | null)?.unrejectedAt;
  return unrejectedAt === undefined || unrejectedAt === null;
}

/**
 * File ids this transaction currently rejects, from either stored shape.
 *
 * Takes `unknown` on purpose: callers hand it a raw DocumentData, a typed
 * Transaction, or a two-field projection, and neither field is declared on most
 * of those types. Every value read is shape-checked below.
 */
export function readRejectedFileIds(txData: unknown): Set<string> {
  const ids = new Set<string>();
  const source = (txData ?? {}) as TransactionRejectionFields;

  const legacy = source.rejectedFileIds;
  if (Array.isArray(legacy)) {
    for (const id of legacy) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }

  const records = source.rejectedFiles;
  if (Array.isArray(records)) {
    for (const record of records) {
      // A reversed rejection stays in the array as history and stops counting
      // here — that is the whole of what undo does to the read side.
      if (!isActiveRejection(record)) continue;
      const id = (record as { fileId?: unknown } | null)?.fileId;
      if (typeof id === "string" && id) ids.add(id);
    }
  }

  return ids;
}

/**
 * Single-pair check, for callers scoring one file against one transaction.
 * Callers looping over many files for the same transaction should hoist
 * readRejectedFileIds out of the loop instead.
 */
export function isFileRejected(txData: unknown, fileId: string): boolean {
  return readRejectedFileIds(txData).has(fileId);
}
