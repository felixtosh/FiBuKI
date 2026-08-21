/**
 * How a transaction is documented (#104) — pure derivation and its guard.
 *
 * `isComplete` is deliberately untouched by all of this. It keeps its current
 * meaning of "has some documentation", so no line that is green today turns
 * red, no existing view changes behaviour, and the transaction corpus is not
 * re-triggered en masse. The gap becomes visible through the new queue, not
 * through the old flag flipping.
 */

import type { DocumentType, DocumentationState } from "./types";

export interface DocumentationInput {
  /**
   * The document types of the files attached to this transaction. `null` or
   * `undefined` is a file whose record predates classification — that is
   * "not established", never "not a document".
   */
  fileTypes: Array<DocumentType | null | undefined>;
  hasNoReceiptCategory: boolean;
}

/**
 * The invoice-wins ordering is deliberate: a transaction holding both a
 * receipt and an invoice is properly documented, and the extra receipt must
 * never downgrade it.
 *
 * Files outrank a no-receipt category. A category is how a line with no
 * document is resolved; once a document exists, what the document is decides.
 */
export function deriveDocumentationState(input: DocumentationInput): DocumentationState {
  const { fileTypes, hasNoReceiptCategory } = input;

  if (fileTypes.length > 0) {
    if (fileTypes.includes("invoice")) return "invoice";
    if (fileTypes.includes("receipt")) return "receipt-only";
    // Everything attached is `unknown`, `other`, or unclassified. A tax form
    // or a delivery note says nothing about whether an invoice was received,
    // so the honest answer is that this has not been established.
    return "unknown";
  }

  if (hasNoReceiptCategory) return "no-receipt-category";

  return "undocumented";
}

/** The slice of a transaction record the guard reads. */
export interface DocumentationGuardState {
  fileIds?: string[] | null;
  noReceiptCategoryId?: string | null;
  documentationState?: DocumentationState | null;
}

/**
 * Should the trigger re-derive the documentation state for this update?
 *
 * Widened minimally from the existing `isComplete` guard: the attached files
 * or the category changed, or the state has never been derived at all — which
 * is what lets rows written before #104 fill in the first time they are
 * touched, without a backfill job.
 *
 * A file's own classification changing is NOT visible from here; the
 * extraction path propagates that itself, calling the same derivation.
 */
export function shouldRecomputeDocumentationState(
  before: DocumentationGuardState,
  after: DocumentationGuardState
): boolean {
  if (!after.documentationState) return true;

  const fileIdsChanged =
    JSON.stringify(before.fileIds ?? []) !== JSON.stringify(after.fileIds ?? []);
  const categoryChanged = (before.noReceiptCategoryId ?? null) !== (after.noReceiptCategoryId ?? null);

  return fileIdsChanged || categoryChanged;
}

/** Is the derived state worth writing? Writing an unchanged value would re-fire the trigger. */
export function documentationStateChanged(
  stored: DocumentationState | null | undefined,
  derived: DocumentationState
): boolean {
  return stored !== derived;
}
