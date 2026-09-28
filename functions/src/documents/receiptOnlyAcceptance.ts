/**
 * Accepted Receipt (#165) - the recorded ruling that a receipt-only
 * transaction's evidence is as good as it will ever get.
 *
 * The legitimate case is ordinary: a marketplace seller who charges no VAT,
 * from whom no § 11-complete invoice is obtainable, where the Receipt fully
 * documents the spend as a Betriebsausgabe. The line is CORRECTLY
 * receipt-only and CORRECTLY closed, and without this record the chase queue
 * holds it forever - a worklist whose floor is permanently above zero stops
 * meaning "work exists".
 *
 * The ruling is a ruling, not a hide: who ruled, when, why, over which
 * files. It never touches the Documentation State, `isComplete`, the UVA or
 * the BMD export - the line stays receipt-only and still carries no input
 * VAT. And it never deletes itself: it goes STALE, derived on read, the
 * moment the evidence it ruled over changes.
 */

export interface ReceiptOnlyAcceptance {
  /** Who ruled - the user id the acting party authenticated as. */
  by: string;
  /**
   * When the ruling was made. Opaque here (admin Timestamp in Firestore,
   * client Timestamp in the UI): liveness never reads it.
   */
  at: unknown;
  /** Why no § 11 invoice is obtainable. Required - the reason IS the record. */
  reason: string;
  /** The connected file ids the ruling was made over. */
  fileIds: string[];
}

/** The slice of a transaction record liveness reads. */
export interface AcceptanceSubject {
  fileIds?: string[] | null;
  documentationState?: string | null;
  receiptOnlyAcceptance?: ReceiptOnlyAcceptance | null;
}

/**
 * Is the recorded ruling still about the evidence the transaction holds?
 *
 * Live exactly while the transaction is still `receipt-only` over the same
 * SET of files the ruling named. A file added or removed, or a documentation
 * state that moved (the invoice finally arrived, the receipt was detached),
 * makes the ruling stale - it stays on the record as history, but it excludes
 * nothing from the chase queue any more.
 */
export function isAcceptanceLive(tx: AcceptanceSubject): boolean {
  const acceptance = tx.receiptOnlyAcceptance;
  if (!acceptance) return false;
  if (tx.documentationState !== "receipt-only") return false;

  const current = new Set(tx.fileIds ?? []);
  const ruledOver = new Set(acceptance.fileIds ?? []);
  if (current.size !== ruledOver.size) return false;
  for (const id of ruledOver) {
    if (!current.has(id)) return false;
  }
  return true;
}
