/**
 * Keeping the direction-review flags in step with the links (#233).
 *
 * The rule itself is pure and lives in `directionReview.ts`. This module owns
 * only the reads and the write-if-changed, the same split as
 * `syncDocumentationState.ts`.
 *
 * Three callers, because three different things can move the answer:
 *  - `onTransactionUpdate`, when a transaction gains or loses files, or when
 *    its amount changes;
 *  - the extraction path, when a file's direction is (re)decided;
 *  - `update_file_extraction`, when a person sets the direction by hand.
 */

import { getFirestore } from "firebase-admin/firestore";
import {
  directionReviewFields,
  reviewDirection,
  toDirectionFacts,
  type DirectionTransactionFacts,
} from "./directionReview";

type Firestore = ReturnType<typeof getFirestore>;

/**
 * The transactions a file is linked to.
 *
 * A dangling id contributes nothing rather than a zero-amount transaction:
 * a reference that no longer resolves is not evidence about direction.
 */
async function readLinkedTransactions(
  db: Firestore,
  transactionIds: string[]
): Promise<DirectionTransactionFacts[]> {
  const snaps = await Promise.all(
    transactionIds.map((id) => db.collection("transactions").doc(id).get())
  );

  return snaps
    .filter((snap) => snap.exists)
    .map((snap) => ({
      id: snap.id,
      amount: typeof snap.data()?.amount === "number" ? (snap.data()!.amount as number) : 0,
    }));
}

/**
 * Compute the flags for one already-loaded file record.
 *
 * Exported so the extraction path can fold them into the write it is already
 * making, instead of writing the file twice.
 */
export async function computeDirectionReviewFields(
  db: Firestore,
  fileRecord: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const transactionIds = (fileRecord.transactionIds as string[] | undefined) ?? [];
  const transactions = await readLinkedTransactions(db, transactionIds);

  return directionReviewFields(reviewDirection(toDirectionFacts(fileRecord, transactions)));
}

/**
 * Re-derive and, only when something actually moved, write the flags of each
 * named file.
 *
 * Writing an unchanged value would cost a document write and re-fire every
 * trigger watching the files collection, which is the loop the equivalent
 * documentation-state sync exists to avoid. Failures are logged, never thrown:
 * this runs after the write that prompted it has already succeeded, and losing
 * a review flag must not turn a completed operation into a failed one.
 */
export async function syncDirectionReviewForFiles(
  db: Firestore,
  fileIds: string[]
): Promise<void> {
  for (const fileId of fileIds) {
    try {
      const ref = db.collection("files").doc(fileId);
      const snap = await ref.get();
      if (!snap.exists) continue;

      const record = snap.data() as Record<string, unknown>;
      const fields = await computeDirectionReviewFields(db, record);

      const changed = Object.entries(fields).some(([field, value]) => {
        const stored = record[field];
        if (Array.isArray(value)) {
          const storedArray = Array.isArray(stored) ? stored : [];
          return (
            storedArray.length !== value.length ||
            storedArray.some((entry, index) => entry !== value[index])
          );
        }
        return (stored ?? null) !== value;
      });
      if (!changed) continue;

      await ref.update(fields);
      console.log(
        `[DirectionReview] file ${fileId}: ${fields.needsDirectionReview ? fields.directionReviewReason : "clear"}`
      );
    } catch (error) {
      console.error(`[DirectionReview] Failed to sync file ${fileId}:`, error);
    }
  }
}
