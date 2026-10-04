/**
 * Re-score one File's suggestions after its facts moved (#637 user stories 12
 * and 13).
 *
 * The one entry point for "a File's facts changed, refresh what it suggests":
 * the File facts module asks for it after a Hand Correction that moved the
 * amount, the date, a Due or Debit Date, the partner, the IBAN or the VAT ID,
 * and any other path that changes those facts by hand calls this rather than
 * a matcher of its own, so the rule lives in one place.
 *
 * Suggestions only. The candidates and scores are the matcher's (#613), the
 * upload trigger's own, so what is stored here is what the trigger would
 * store; but nothing is auto-connected, disconnected or un-assigned, and the
 * pipeline flags (`transactionMatchComplete`) are left alone so the File-side
 * trigger does not re-fire off this write. A correction never changes a
 * booking behind the User's back. "Refresh matches" keeps its own rule,
 * which auto-connects (#612).
 */

import { Timestamp } from "firebase-admin/firestore";
import { storedSuggestionsOf, transactionsForFile } from "./matcher";

export interface RescoreFileSuggestionsResult {
  rescored: boolean;
  /** Why nothing was written, when nothing was. */
  skipped?: "missing" | "not-yet-scored" | "ineligible";
  suggestionCount?: number;
}

export async function rescoreFileSuggestions(
  db: FirebaseFirestore.Firestore,
  fileId: string
): Promise<RescoreFileSuggestionsResult> {
  const ref = db.collection("files").doc(fileId);
  const snap = await ref.get();
  if (!snap.exists) return { rescored: false, skipped: "missing" };

  const data = snap.data()!;
  // A File still in its pipeline is scored by its own trigger, against the
  // facts as they now stand; racing it would store a second opinion.
  if (data.transactionMatchComplete !== true) return { rescored: false, skipped: "not-yet-scored" };

  const result = await transactionsForFile(db, data.userId as string, { id: fileId, data });
  // Never matched (deleted, a Copy, not an invoice, addressed to someone
  // else): left as it is.
  if (result.ineligible) return { rescored: false, skipped: "ineligible" };

  const suggestions = storedSuggestionsOf(result.matches);
  await ref.update({
    transactionSuggestions: suggestions,
    transactionMatchedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });

  return { rescored: true, suggestionCount: suggestions.length };
}
