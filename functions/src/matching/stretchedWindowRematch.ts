/**
 * The one-time rematch after #614 widened the date window.
 *
 * A File's window now reaches to a week past its Due Date or Debit Date. A
 * File matched before that never saw the Transactions its stretch adds, so
 * this pass re-matches every unconnected File whose window reaches past its
 * date + 30 days, the same way an upload does: it stores the suggestions the
 * matcher scores now and auto-connects at the normal threshold, through the
 * File Connection writer (#612). A User in passive mode gets suggestions only,
 * as on upload. It sends no notification and queues no agentic search.
 *
 * A dry run writes nothing and reports what an apply would do. Its
 * auto-connect count is an upper bound: an apply runs File by File, so a
 * Transaction one File takes can no longer be taken by the next.
 */

import { Timestamp } from "firebase-admin/firestore";
import { isPassiveMode } from "../utils/checkAutomationMode";
import { toDateSafe } from "../utils/toDateSafe";
import {
  autoConnect,
  selectAutoConnects,
  storedSuggestionsOf,
  stretchesWindow,
  transactionsForFile,
} from "./matcher";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;

export interface StretchedRematchFile {
  fileId: string;
  userId: string;
  /** Suggestions stored now whose Transaction was not suggested before. */
  newSuggestions: string[];
  /** Transactions auto-connected (with --apply) or that would be (dry run). */
  autoConnected: string[];
}

export interface StretchedRematchReport {
  apply: boolean;
  /** Files read. */
  filesScanned: number;
  /** Unconnected Files with a stretched window, which the pass re-matched. */
  filesTouched: number;
  /** Suggestions that are new on their File, summed. */
  newSuggestions: number;
  /** Auto-connects made (or, in a dry run, at most this many). */
  autoConnects: number;
  /** Every touched File that gained a suggestion or a connection. */
  changed: StretchedRematchFile[];
}

/** Is this File one the pass re-matches? Unconnected, finished, live, stretched. */
function isCandidate(data: Data): boolean {
  if (data.deletedAt || data.purgedAt) return false;
  if (Array.isArray(data.transactionIds) && data.transactionIds.length > 0) return false;
  if (data.extractionComplete !== true || data.transactionMatchComplete !== true) return false;
  return stretchesWindow(data);
}

function suggestedIds(data: Data): Set<string> {
  const stored = Array.isArray(data.transactionSuggestions) ? data.transactionSuggestions : [];
  return new Set(
    stored.map((s: { transactionId?: unknown }) => s?.transactionId).filter((id): id is string => typeof id === "string")
  );
}

/** Run the pass over every File the database holds, oldest File date first. */
export async function rematchStretchedWindows(
  db: Db,
  options: { apply: boolean }
): Promise<StretchedRematchReport> {
  const snapshot = await db.collection("files").get();
  const candidates = snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .filter((f) => isCandidate(f.data))
    .sort(
      (a, b) =>
        (toDateSafe(a.data.extractedDate)?.getTime() ?? 0) - (toDateSafe(b.data.extractedDate)?.getTime() ?? 0)
    );

  const report: StretchedRematchReport = {
    apply: options.apply,
    filesScanned: snapshot.size,
    filesTouched: 0,
    newSuggestions: 0,
    autoConnects: 0,
    changed: [],
  };
  const passive = new Map<string, boolean>();

  for (const candidate of candidates) {
    // Read again: an earlier File of this pass, or the app, may have moved it.
    const fresh = options.apply ? (await db.collection("files").doc(candidate.id).get()).data() : candidate.data;
    if (!fresh || !isCandidate(fresh)) continue;
    const userId = fresh.userId as string;
    const file = { id: candidate.id, data: fresh };

    const result = await transactionsForFile(db, userId, file);
    if (result.ineligible) continue;
    report.filesTouched++;

    const suggestions = storedSuggestionsOf(result.matches);
    const before = suggestedIds(fresh);
    const newSuggestions = suggestions.map((s) => s.transactionId).filter((id) => !before.has(id));

    if (!passive.has(userId)) passive.set(userId, await isPassiveMode(userId));
    const { picks } = passive.get(userId)
      ? { picks: [] }
      : await selectAutoConnects(db, userId, file, result);

    let autoConnected = picks.map((p) => p.match.transactionId);
    if (options.apply) {
      autoConnected = (await autoConnect(db, userId, file.id, picks)).map((p) => p.match.transactionId);
      await db.collection("files").doc(file.id).update({
        transactionSuggestions: suggestions,
        transactionMatchedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
    }

    report.newSuggestions += newSuggestions.length;
    report.autoConnects += autoConnected.length;
    if (newSuggestions.length > 0 || autoConnected.length > 0) {
      report.changed.push({ fileId: file.id, userId, newSuggestions, autoConnected });
    }
  }
  return report;
}
