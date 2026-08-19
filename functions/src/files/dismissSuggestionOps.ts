/**
 * Transaction-suggestion dismissal, shared by the callable and the MCP tools.
 *
 * The callable (dismissTransactionSuggestion) drives the UI's dismiss action;
 * the tool handlers of the same name drive the MCP surface. Both must write the
 * identical field set, or a pair rejected by an agent and a pair rejected by a
 * click end up in different states and the learning export reads two different
 * histories — so the update objects are built here and nowhere else.
 *
 * Mirrors files/notInvoiceOps, which shares the mark/unmark builders the same
 * way (fork #61).
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  isActiveDismissal,
  isTransactionDismissed,
} from "../matching/dismissedTransactions";

/** Free text stored with a rejection. Longer than this is refused, not truncated. */
export const MAX_DISMISSAL_REASON_LENGTH = 500;

export interface TransactionSuggestion {
  transactionId: string;
  confidence: number;
  matchSources?: Array<{
    type: string;
    weight: number;
    details?: string;
  }>;
  suggestedAt?: unknown;
}

export interface DismissedTransactionEntry {
  transactionId: string;
  dismissedAt: unknown;
  confidence?: number | null;
  /** Free text from the rejecting agent. Absent on every record written before fork #93. */
  reason?: string | null;
  /**
   * When this rejection was taken back (fork #95). Present means the record is
   * history and no longer suppresses the pair — `isActiveDismissal` in
   * matching/dismissedTransactions is the one place that reads it that way.
   * Absent on every record that has not been undone.
   */
  undismissedAt?: unknown;
}

/**
 * Fields the dismissal reads. Deliberately narrow: everything else on the file
 * document is irrelevant to the decision.
 */
export interface DismissibleFileState {
  transactionSuggestions?: TransactionSuggestion[];
  /** @deprecated legacy string[] kept in step with dismissedTransactions */
  dismissedTransactionIds?: string[];
  dismissedTransactions?: DismissedTransactionEntry[];
}

export interface DismissSuggestionOutcome {
  updates: Record<string, unknown>;
  /**
   * Confidence of the suggestion that was removed, or null when the pair was
   * not currently suggested — which is the normal case on a sweep re-run.
   */
  dismissedConfidence: number | null;
  /** True when the pair was already on the blacklist before this call. */
  alreadyDismissed: boolean;
}

export interface UndismissSuggestionOutcome {
  /**
   * Empty when the pair was not dismissed. Undoing a rejection that was never
   * made writes nothing at all rather than touching `updatedAt`, so a sweep
   * clearing a speculative list does not stamp every file it looked at.
   * Callers must skip the write on an empty object — Firestore refuses one.
   */
  updates: Record<string, unknown>;
  wasDismissed: boolean;
}

/**
 * Validate a caller-supplied rejection reason without deciding how to complain
 * about it: the callable answers in HttpsError codes and the tool handler in
 * plain errors, but the rule they enforce has to be the one rule.
 *
 * Returns the message to reject with, or null when the reason is acceptable.
 * `null`/`undefined` are acceptable — a rejection needs no explanation.
 */
export function checkDismissalReason(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== "string") return "reason must be a string";
  if (reason.length > MAX_DISMISSAL_REASON_LENGTH) {
    return `reason must be at most ${MAX_DISMISSAL_REASON_LENGTH} characters`;
  }
  return null;
}

function dismissedIds(fileData: DismissibleFileState): string[] {
  return fileData.dismissedTransactionIds ?? [];
}

function dismissedRecords(fileData: DismissibleFileState): DismissedTransactionEntry[] {
  return fileData.dismissedTransactions ?? [];
}

/**
 * True when this file *currently* rejects this transaction, in either the
 * legacy id array or the record array.
 *
 * A thin typed alias over `isTransactionDismissed` in
 * matching/dismissedTransactions, which owns this question for every reader —
 * matching, both analytics exports and, since fork #101, the agent tools. The
 * two used to be separate implementations of the same rule over the same two
 * fields, which is one implementation too many for a rule that decides whether
 * a rejection holds. The alias survives only for the typed `DismissibleFileState`
 * signature the write builders in this module already work in; the reader takes
 * `unknown` because most of its callers hold a raw Firestore document.
 */
export function isTransactionDismissedForFile(
  fileData: DismissibleFileState,
  transactionId: string
): boolean {
  return isTransactionDismissed(fileData, transactionId);
}

/** Whether an unreversed rejection record exists for this pair. */
function hasActiveDismissalRecord(
  fileData: DismissibleFileState,
  transactionId: string
): boolean {
  return dismissedRecords(fileData).some(
    (d) => d.transactionId === transactionId && isActiveDismissal(d)
  );
}

/**
 * Rejecting a pair drops the suggestion from the file's queue and blacklists
 * the transaction so re-scoring does not propose it again.
 *
 * Both arrays are rewritten whole rather than appended with arrayUnion: the
 * rejection records differ by `dismissedAt`, so arrayUnion cannot dedupe them
 * and a repeated sweep would stack duplicate records that skew the learning
 * export. The per-array checks here are what make a re-run a no-op — and they
 * are per-array on purpose, so a document written before the record format
 * still gains its record instead of being skipped on the strength of its
 * legacy id alone. The read and the write belong in one Firestore transaction:
 * whole-array writes lose a concurrent rejection otherwise.
 *
 * The record check is for an *active* record (fork #95). Rejecting a pair that
 * was rejected and then un-rejected appends a second record rather than
 * matching the reversed one and writing nothing: the array is the history of
 * what was decided about this pair, and "rejected, taken back, rejected again"
 * is three decisions, not one.
 */
export function buildDismissSuggestionUpdates(
  fileData: DismissibleFileState,
  transactionId: string,
  reason?: string | null
): DismissSuggestionOutcome {
  const suggestions = fileData.transactionSuggestions ?? [];
  const dismissed = suggestions.find((s) => s.transactionId === transactionId);

  const ids = dismissedIds(fileData);
  const records = dismissedRecords(fileData);
  const hasId = ids.includes(transactionId);
  const hasActiveRecord = hasActiveDismissalRecord(fileData, transactionId);

  const updates: Record<string, unknown> = {
    transactionSuggestions: suggestions.filter((s) => s.transactionId !== transactionId),
    dismissedTransactionIds: hasId ? ids : [...ids, transactionId],
    dismissedTransactions: hasActiveRecord
      ? records
      : [
          ...records,
          {
            transactionId,
            dismissedAt: Timestamp.now(),
            confidence: dismissed?.confidence ?? null,
            reason: reason ?? null,
          },
        ],
    updatedAt: FieldValue.serverTimestamp(),
  };

  return {
    updates,
    // Reports what this call actually removed. Null means the pair was not on
    // the suggestion list — the normal answer on a sweep re-run, and the reason
    // a re-run is a no-op rather than an error.
    dismissedConfidence: dismissed?.confidence ?? null,
    alreadyDismissed: hasId || hasActiveRecord,
  };
}

/**
 * Undoing a rejection lifts the suppression and keeps the note.
 *
 * The transaction leaves `dismissedTransactionIds`, which is the list matching
 * enforces against. Its `dismissedTransactions` record stays, stamped
 * `undismissedAt`: a sweep reading the file afterwards can still see that this
 * pair was rejected, at what confidence and for what reason, and then restored,
 * so it can reach the same conclusion again on its own evidence. Deleting the
 * record would hide the attempt and invite the same wrong pairing to be
 * re-litigated from scratch.
 *
 * `transactionSuggestions` is deliberately untouched. Undo restores
 * eligibility, it does not fabricate a suggestion — only `confidence` survived
 * the dismissal, so a re-inserted entry would be missing the match sources that
 * justify it. The pair reappears when transaction matching next runs.
 *
 * Undoing a pair that is not dismissed writes nothing.
 */
export function buildUndismissSuggestionUpdates(
  fileData: DismissibleFileState,
  transactionId: string
): UndismissSuggestionOutcome {
  const wasDismissed = isTransactionDismissedForFile(fileData, transactionId);

  if (!wasDismissed) {
    return { updates: {}, wasDismissed: false };
  }

  const undismissedAt = Timestamp.now();

  return {
    updates: {
      dismissedTransactionIds: dismissedIds(fileData).filter((id) => id !== transactionId),
      // Stamp every active record for this pair — normally exactly one. Already
      // reversed records keep their original stamp, so the log reads as the
      // sequence of decisions it is.
      dismissedTransactions: dismissedRecords(fileData).map((d) =>
        d.transactionId === transactionId && isActiveDismissal(d)
          ? { ...d, undismissedAt }
          : d
      ),
      updatedAt: FieldValue.serverTimestamp(),
    },
    wasDismissed: true,
  };
}
