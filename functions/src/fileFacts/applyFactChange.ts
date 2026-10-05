/**
 * The one applier of the File facts module (#637, #638).
 *
 * Reads what the module needs (the File, the Transactions it is connected
 * to), asks the module, writes the update it returns and runs the follow-ups.
 * Nothing is written on a refusal. Every path that changes a File's extracted
 * facts goes through here, so the write and its follow-ups happen the same
 * way whichever door the change came in by.
 */

import type { Firestore } from "firebase-admin/firestore";
import { readLinkedTransactions } from "../documents/syncDirectionReview";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { rescoreFileSuggestions } from "../matching/rescoreFileSuggestions";
import { decideFactChange, type FactChange, type FactUpdate, type FollowUp } from "./factChange";

export interface ApplyFactChangeRequest {
  fileId: string;
  /** The caller's uid. The File must belong to it. */
  userId: string;
  change: FactChange;
}

export type AppliedFactChange =
  | (FactUpdate & {
      /** The File as it was read. */
      before: Record<string, unknown>;
      /** The File as the update left it. */
      after: Record<string, unknown>;
    })
  | { refused: true; code: "NOT_FOUND" | "INVALID" | "HAND_CORRECTED"; message: string; fields?: string[] };

export async function applyFactChange(
  db: Firestore,
  { fileId, userId, change }: ApplyFactChangeRequest
): Promise<AppliedFactChange> {
  const ref = db.collection("files").doc(fileId);
  const snap = await ref.get();

  // Someone else's File answers like a missing one: every user shares one
  // tenant, so its existence is not the caller's business.
  if (!snap.exists || snap.data()?.userId !== userId) {
    return { refused: true, code: "NOT_FOUND", message: "File not found" };
  }

  const record = snap.data()!;
  const transactionIds = Array.isArray(record.transactionIds) ? (record.transactionIds as string[]) : [];
  const linkedTransactions = await readLinkedTransactions(db, transactionIds);

  const outcome = decideFactChange({ record, linkedTransactions }, change);
  if (outcome.refused) return outcome;

  if (Object.keys(outcome.update).length > 0) {
    await ref.update(outcome.update);
  }

  await runFollowUps(db, fileId, outcome.followUps);

  return { ...outcome, before: record, after: { ...record, ...outcome.update } };
}

/**
 * Carry out the follow-ups. The write they follow has already succeeded, so a
 * failing follow-up is logged, never thrown: the User's correction stands, and
 * a stale derived state is repaired by the next change that touches it.
 */
async function runFollowUps(db: Firestore, fileId: string, followUps: FollowUp[]): Promise<void> {
  for (const followUp of followUps) {
    try {
      if (followUp.kind === "sync-documentation-state") {
        await syncDocumentationStateForTransactions(db, followUp.transactionIds);
      } else if (followUp.kind === "rescore-suggestions") {
        await rescoreFileSuggestions(db, fileId);
      }
    } catch (error) {
      console.error(`[FileFacts] Follow-up ${followUp.kind} failed for file ${fileId}:`, error);
    }
  }
}
