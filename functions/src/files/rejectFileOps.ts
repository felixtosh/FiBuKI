/**
 * File-rejection field writes on the transaction document (fork #102).
 *
 * disconnectFileFromTransaction records a rejection in two shapes — the legacy
 * `rejectedFileIds` string array and the `rejectedFiles` records carrying
 * `rejectedAt` and `matchConfidence`. Undo has to answer both, so the update
 * object is built here rather than inline in the callable, matching how
 * files/dismissSuggestionOps holds the builders for the file-side pair.
 *
 * Reading — "does this rejection still hold?" — is not here: matching/
 * rejectedFiles owns that for every reader.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { isActiveRejection, isFileRejected } from "../matching/rejectedFiles";

/** A record in the `rejectedFiles` array. */
export interface RejectedFileEntry {
  fileId: string;
  rejectedAt: unknown;
  matchConfidence?: number | null;
  /**
   * When this rejection was taken back (fork #102). Present means the record is
   * history and no longer suppresses the pair — `isActiveRejection` in
   * matching/rejectedFiles is the one place that reads it that way. Absent on
   * every record that has not been undone.
   */
  unrejectedAt?: unknown;
}

/**
 * Fields the rejection reads. Deliberately narrow: everything else on the
 * transaction document is irrelevant to the decision.
 */
export interface RejectableTransactionState {
  /** @deprecated legacy string[] kept in step with rejectedFiles */
  rejectedFileIds?: string[];
  rejectedFiles?: RejectedFileEntry[];
}

export interface UnrejectFileOutcome {
  /**
   * Empty when the file was not rejected. Un-rejecting a pair that was never
   * rejected writes nothing at all rather than touching `updatedAt`, so a sweep
   * clearing a speculative list does not stamp every transaction it looked at.
   * Callers must skip the write on an empty object — Firestore refuses one.
   */
  updates: Record<string, unknown>;
  wasRejected: boolean;
}

/**
 * Un-rejecting a file lifts the suppression and keeps the note.
 *
 * The file leaves `rejectedFileIds`, which is the legacy list several readers
 * still enforce against. Its `rejectedFiles` record stays, stamped
 * `unrejectedAt`: the record carries the confidence the matcher had when the
 * user rejected it, which is exactly the signal learnScoringWeights and both
 * analytics exports are built on. Deleting it would erase that history; leaving
 * it unstamped is the #102 defect, where the surviving record kept the pair
 * excluded forever.
 *
 * Both arrays are rewritten whole rather than mutated with arrayRemove: the
 * record has to be matched on `fileId` and stamped, which arrayRemove cannot
 * express, and mixing a whole-array write with a transform on the sibling field
 * invites the two to disagree again. The read and the write therefore belong in
 * one Firestore transaction — the caller's job.
 *
 * Un-rejecting a file that is not rejected writes nothing.
 */
export function buildUnrejectFileUpdates(
  txData: RejectableTransactionState,
  fileId: string
): UnrejectFileOutcome {
  const wasRejected = isFileRejected(txData, fileId);

  if (!wasRejected) {
    return { updates: {}, wasRejected: false };
  }

  const unrejectedAt = Timestamp.now();
  const records = txData.rejectedFiles ?? [];

  return {
    updates: {
      rejectedFileIds: (txData.rejectedFileIds ?? []).filter((id) => id !== fileId),
      // Stamp every active record for this pair — normally exactly one. Already
      // reversed records keep their original stamp, so the log reads as the
      // sequence of decisions it is.
      rejectedFiles: records.map((record) =>
        record?.fileId === fileId && isActiveRejection(record)
          ? { ...record, unrejectedAt }
          : record
      ),
      updatedAt: FieldValue.serverTimestamp(),
    },
    wasRejected: true,
  };
}
