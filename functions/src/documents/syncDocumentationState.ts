/**
 * Keeping a transaction's documentation state in step with its files (#104).
 *
 * Two callers, one derivation:
 *  - `onTransactionUpdate`, when the attached files or the no-receipt
 *    category change;
 *  - the extraction path, when a file's own classification changes — which
 *    the transaction trigger cannot see, because nothing on the transaction
 *    document moved.
 *
 * The derivation itself is pure and lives in `documentationState.ts`. This
 * module owns only the reads.
 */

import { getFirestore } from "firebase-admin/firestore";
import { deriveDocumentationState, documentationStateChanged } from "./documentationState";
import type { DocumentType, DocumentationState } from "./types";

type Firestore = ReturnType<typeof getFirestore>;

function asDocumentType(value: unknown): DocumentType | null {
  return value === "invoice" || value === "receipt" || value === "other" || value === "unknown"
    ? value
    : null;
}

/**
 * The document types of a transaction's attached files.
 *
 * A file id that no longer resolves contributes nothing: it is a dangling
 * reference, not an unclassified document, and counting it as `unknown` would
 * park the transaction in the unknown bucket forever.
 */
async function readFileTypes(db: Firestore, fileIds: string[]): Promise<Array<DocumentType | null>> {
  const snaps = await Promise.all(
    fileIds.map((id) => db.collection("files").doc(id).get())
  );

  return snaps
    .filter((snap) => snap.exists)
    .map((snap) => asDocumentType(snap.data()?.documentType));
}

/** Derive the state for one transaction record, reading its files. */
export async function deriveForTransaction(
  db: Firestore,
  transaction: { fileIds?: string[] | null; noReceiptCategoryId?: string | null }
): Promise<DocumentationState> {
  const fileIds = transaction.fileIds ?? [];
  const fileTypes = fileIds.length > 0 ? await readFileTypes(db, fileIds) : [];

  return deriveDocumentationState({
    fileTypes,
    hasNoReceiptCategory: !!transaction.noReceiptCategoryId,
  });
}

/**
 * Re-derive and, only when it actually moved, write the documentation state
 * of each named transaction.
 *
 * Writing an unchanged value would re-fire `onTransactionUpdate` for nothing,
 * which is the loop the trigger's early-return-after-write pattern exists to
 * avoid. Failures are logged, never thrown: this runs after the extraction
 * write has already succeeded, and losing the propagation must not turn a
 * completed extraction into a failed one.
 */
export async function syncDocumentationStateForTransactions(
  db: Firestore,
  transactionIds: string[]
): Promise<void> {
  for (const transactionId of transactionIds) {
    try {
      const ref = db.collection("transactions").doc(transactionId);
      const snap = await ref.get();
      if (!snap.exists) continue;

      const data = snap.data() as {
        fileIds?: string[] | null;
        noReceiptCategoryId?: string | null;
        documentationState?: DocumentationState | null;
      };

      const derived = await deriveForTransaction(db, data);
      if (!documentationStateChanged(data.documentationState, derived)) continue;

      await ref.update({ documentationState: derived });
      console.log(
        `[DocState] transaction ${transactionId}: ${data.documentationState ?? "(unset)"} -> ${derived}`
      );
    } catch (error) {
      console.error(`[DocState] Failed to sync transaction ${transactionId}:`, error);
    }
  }
}
