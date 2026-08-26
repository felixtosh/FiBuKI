/**
 * Is this document's direction believable? (#233)
 *
 * `invoiceDirection` decides whether a document is a purchase or a sale, and
 * until now it had no surface of its own: it was rendered as the SIGN of the
 * amount, where `unknown` fell through to a positive figure. So a purchase
 * invoice whose direction was never established displayed as green income,
 * identical in style to a real sale, for a large minority of a real file set,
 * with nothing in the product saying so.
 *
 * Two rules, one queue:
 *
 *   **The cross-check.** Once a file is linked to a transaction the direction
 *   is no longer a guess. An incoming document is a purchase, so the money
 *   left the account; an outgoing one is a sale, so it arrived. A file whose
 *   direction contradicts the bank line it is attached to is one of the two
 *   being wrong, and both are worth a person's attention. Audited against real
 *   links it found only true defects and no false ones, most of them sales
 *   invoices stapled to unrelated outgoing payments.
 *
 *   **The undirected population.** A file with no direction at all is not
 *   wrong yet, but nothing downstream can be right about it either: the agent
 *   read tools apply the same sign rule, and the accountant export writes the
 *   field out verbatim.
 *
 * Pure data in, verdict out — the same discipline as `classifyDocumentType`
 * and `vatRateReview`, and for the same reason.
 */

/** Which way a document points. Mirrors `InvoiceDirection` on the file record. */
export type InvoiceDirection = "incoming" | "outgoing" | "unknown";

/** Why a file is on the direction review list. */
export type DirectionReviewReason =
  /** The linked transaction's sign contradicts the document's direction. */
  | "conflict"
  /** No direction was ever established for this document. */
  | "unknown-direction";

/** One linked transaction, as far as this rule cares. */
export interface DirectionTransactionFacts {
  id: string;
  /** Signed amount. Negative is money out of the account. */
  amount: number;
}

export interface DirectionFacts {
  invoiceDirection?: InvoiceDirection;
  /** The transactions this file is currently connected to. */
  transactions: DirectionTransactionFacts[];
  /** Already ruled out as a financial document — it has no direction to hold. */
  isNotInvoice?: boolean;
  /** Extraction has run. Before that there is nothing to have got wrong. */
  extractionComplete?: boolean;
}

export interface DirectionReviewResult {
  needsReview: boolean;
  reason: DirectionReviewReason | null;
  /** The linked transactions whose sign contradicts the document. */
  conflictingTransactionIds: string[];
  /**
   * The direction the linked transactions imply, when they agree on one.
   * Null when nothing is linked, or when the links disagree with each other —
   * a suggestion nobody can act on is worse than none.
   */
  suggestedDirection: InvoiceDirection | null;
}

const NOTHING_TO_REVIEW: DirectionReviewResult = {
  needsReview: false,
  reason: null,
  conflictingTransactionIds: [],
  suggestedDirection: null,
};

/** Money out is a purchase; money in is a sale. Zero points nowhere. */
function directionOf(amount: number): InvoiceDirection | null {
  if (!Number.isFinite(amount) || amount === 0) return null;
  return amount < 0 ? "incoming" : "outgoing";
}

export function reviewDirection(facts: DirectionFacts): DirectionReviewResult {
  if (facts.isNotInvoice === true) return NOTHING_TO_REVIEW;
  if (facts.extractionComplete === false) return NOTHING_TO_REVIEW;

  const direction = facts.invoiceDirection ?? "unknown";
  const implied = facts.transactions
    .map((tx) => ({ id: tx.id, direction: directionOf(tx.amount) }))
    .filter((tx): tx is { id: string; direction: InvoiceDirection } => tx.direction !== null);

  const distinct = new Set(implied.map((tx) => tx.direction));
  const suggestedDirection = distinct.size === 1 ? [...distinct][0] : null;

  if (direction === "unknown") {
    return {
      needsReview: true,
      reason: "unknown-direction",
      conflictingTransactionIds: [],
      suggestedDirection,
    };
  }

  const conflicting = implied.filter((tx) => tx.direction !== direction).map((tx) => tx.id);
  if (conflicting.length === 0) return NOTHING_TO_REVIEW;

  return {
    needsReview: true,
    reason: "conflict",
    conflictingTransactionIds: conflicting,
    // What the money says, when it says one thing. On a conflict that is by
    // definition not the direction currently stored.
    suggestedDirection,
  };
}

/** A files-collection record, as loosely as this module needs to read one. */
type FileRecord = Record<string, unknown>;

function asDirection(value: unknown): InvoiceDirection {
  return value === "incoming" || value === "outgoing" ? value : "unknown";
}

/**
 * Read the stored record and the transactions it is linked to.
 *
 * The transactions are passed in rather than looked up: this module stays
 * pure, and the caller already holds them — the trigger has the transaction
 * that changed, the extraction path has the file's connections.
 */
export function toDirectionFacts(
  record: FileRecord,
  transactions: DirectionTransactionFacts[]
): DirectionFacts {
  return {
    invoiceDirection: asDirection(record.invoiceDirection),
    transactions,
    isNotInvoice: record.isNotInvoice === true,
    extractionComplete: record.extractionComplete === true,
  };
}

/**
 * The fields a direction review writes onto a file record.
 *
 * `needsDirectionReview` is the queryable flag, the same shape as
 * `needsVatRateReview` (#203). The other three are what let the queue be read
 * without opening the file: why it is listed, which link contradicts it, and
 * what the money says it should be.
 */
export function directionReviewFields(result: DirectionReviewResult): Record<string, unknown> {
  return {
    needsDirectionReview: result.needsReview,
    directionReviewReason: result.reason,
    directionSuggested: result.suggestedDirection,
    directionConflictTransactionIds: result.conflictingTransactionIds,
  };
}
