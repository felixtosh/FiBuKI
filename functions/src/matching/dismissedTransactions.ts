/**
 * Reading the dismissal list a file carries (fork #94, extended by fork #95).
 *
 * dismissTransactionSuggestion writes two shapes of the same fact: the legacy
 * `dismissedTransactionIds` string array and the richer `dismissedTransactions`
 * records (dismissedAt, confidence, reason). Every path that proposes or
 * auto-connects a file-to-transaction pair reads both through here, so a
 * rejection recorded by the UI and one recorded by an agent enforce
 * identically.
 *
 * This module owns the answer to "is this pair still rejected?", and every
 * reader — matching, the write builders in files/dismissSuggestionOps, both
 * analytics exports — asks it here rather than re-deriving it. Undo (fork #95)
 * reverses a rejection by stamping the record, not by deleting it, so a reader
 * that only checks for the record's presence would go on suppressing a pair the
 * user took back.
 */

/** The two fields a file document uses to record dismissed pairs. */
export interface FileDismissalFields {
  dismissedTransactionIds?: unknown;
  dismissedTransactions?: unknown;
}

/**
 * True when a `dismissedTransactions` record still suppresses its pair.
 *
 * Undo keeps the record and stamps it `undismissedAt` instead of removing it
 * (fork #95): the note is the point, so a later sweep can see this pair was
 * rejected, at what confidence and for what reason, and reach its own
 * conclusion on the evidence — informed rather than blocked. Suppression and
 * history are therefore two different questions about the same record, and
 * this is the one that decides suppression.
 *
 * `dismissedTransactions` is a log, not a set: re-dismissing appends a second,
 * unstamped record, so one active record among reversed ones still suppresses.
 *
 * Takes `unknown` for the same reason the readers below do — callers hand it a
 * raw Firestore record whose type declares none of these fields.
 */
export function isActiveDismissal(record: unknown): boolean {
  const undismissedAt = (record as { undismissedAt?: unknown } | null)?.undismissedAt;
  return undismissedAt === undefined || undismissedAt === null;
}

/**
 * Transaction ids this file has had dismissed, from either stored shape.
 *
 * Takes `unknown` on purpose: callers hand it a raw DocumentData, a typed
 * TaxFile, or a projection, and neither of the two fields is declared on most
 * of those types. Every value read is shape-checked below.
 */
export function readDismissedTransactionIds(fileData: unknown): Set<string> {
  const ids = new Set<string>();
  const source = (fileData ?? {}) as FileDismissalFields;

  const legacy = source.dismissedTransactionIds;
  if (Array.isArray(legacy)) {
    for (const id of legacy) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }

  const records = source.dismissedTransactions;
  if (Array.isArray(records)) {
    for (const record of records) {
      // A reversed rejection stays in the array as history and stops counting
      // here — that is the whole of what undo does to the read side.
      if (!isActiveDismissal(record)) continue;
      const id = (record as { transactionId?: unknown } | null)?.transactionId;
      if (typeof id === "string" && id) ids.add(id);
    }
  }

  return ids;
}

/**
 * Single-pair check, for callers scoring one file against one transaction.
 * Callers looping over many transactions for the same file should hoist
 * readDismissedTransactionIds out of the loop instead.
 */
export function isTransactionDismissed(
  fileData: unknown,
  transactionId: string
): boolean {
  return readDismissedTransactionIds(fileData).has(transactionId);
}
