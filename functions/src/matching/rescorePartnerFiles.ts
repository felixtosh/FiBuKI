/**
 * Re-score a Partner's unconnected Files after a Transaction's Partner changed
 * (#139, the forwards half).
 *
 * A File's `transactionSuggestions` are a snapshot written when the File was
 * scored. A Partner assignment on the TRANSACTION side (the matcher's
 * auto-assign, an import sweep, the whole-account re-match) changes what the
 * partner factor is worth on every pair touching that Partner, and nothing
 * recomputed the snapshots — the observed case sat at 43 while the same pair
 * scored 68 with the Partner assigned. The FILE-side trigger
 * (`matchFileTransactions`, reason `partner_changed`) never fires here because
 * the File document did not change.
 *
 * Decision (Felix, 2026-09-27): batch re-scoring once per affected Partner at
 * the end of `applyPartnerMatchUpdates` and `rematchAssignedPartners`. Scope:
 * only unconnected Files of the old and the new Partner. Suggestions only,
 * never auto-connect. The candidates and the scores are the matcher's (#613),
 * the trigger's own, so a refresh stores exactly what the trigger would:
 * the Remainder a Transaction's Files leave open included, which this sweep
 * used to drop by scoring every pair against the full amount.
 *
 * Deliberately additive: this writes `transactionSuggestions` and a timestamp
 * and nothing else. No connection is created, no Partner assignment is
 * cleared, and the pipeline flags (`transactionMatchComplete`) are untouched,
 * so the file-side trigger does not re-fire off these writes.
 *
 * A File dated outside the open stretch keeps its suggestions (#803,
 * ADR-0018): automation leaves Closed and Untracked records alone.
 */

import { Timestamp } from "firebase-admin/firestore";
import { storedSuggestionsOf, transactionsForFiles } from "./matcher";
import { transactionSuggestionsActivity } from "./suggestionActivity";
import { logActivity } from "../utils/activity";
import { automationScope } from "../fiscalYears/settings";

/** Firestore batch write cap is 500; chunk with headroom. */
const BATCH_CHUNK_SIZE = 400;
/** Cap per Partner — the sweep is a refresh, not a migration. */
const MAX_FILES_PER_PARTNER = 200;

export interface RescorePartnerFilesResult {
  partnersProcessed: number;
  filesRescored: number;
}

/**
 * Refresh `transactionSuggestions` on every unconnected, already-scored File
 * of each given Partner. Once per Partner: callers hand in the union of
 * assigned and previous Partner ids and this dedupes them.
 */
export async function rescoreUnconnectedFilesForPartners(
  db: FirebaseFirestore.Firestore,
  userId: string,
  partnerIds: Iterable<string>
): Promise<RescorePartnerFilesResult> {
  const uniquePartnerIds = [...new Set(partnerIds)].filter(Boolean);

  let partnersProcessed = 0;
  let filesRescored = 0;
  const scope = automationScope(db, userId);

  for (const partnerId of uniquePartnerIds) {
    partnersProcessed++;

    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", partnerId)
      .limit(MAX_FILES_PER_PARTNER)
      .get();

    // Unconnected and already through the pipeline: a File mid-pipeline
    // (`transactionMatchComplete` not yet true) is left to its own trigger
    // rather than raced. Which of them can be matched at all is the matcher's.
    const files: typeof filesSnapshot.docs = [];
    for (const doc of filesSnapshot.docs) {
      const data = doc.data();
      if (data.transactionMatchComplete !== true) continue;
      if (Array.isArray(data.transactionIds) && data.transactionIds.length > 0) continue;
      if (await scope.actsOnFile(data)) files.push(doc);
    }

    if (files.length === 0) continue;

    // One window query, one Partner read and one rate read per Partner.
    const results = await transactionsForFiles(
      db,
      userId,
      files.map((doc) => ({ id: doc.id, data: doc.data() }))
    );

    let batch = db.batch();
    let pending = 0;

    for (const [i, fileDoc] of files.entries()) {
      // Never matched (deleted, a Copy, not an invoice, addressed to someone
      // else): left as it is.
      if (results[i].ineligible) continue;
      const suggestions = storedSuggestionsOf(results[i].matches);
      const logged = transactionSuggestionsActivity(fileDoc.data().transactionSuggestions, suggestions, "rescoring after a Partner changed");
      batch.update(fileDoc.ref, {
        transactionSuggestions: suggestions,
        transactionMatchedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        ...(logged ? logActivity(logged) : {}),
      });
      pending++;
      filesRescored++;

      if (pending >= BATCH_CHUNK_SIZE) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }

    if (pending > 0) await batch.commit();
  }

  if (filesRescored > 0) {
    console.log(
      `[RescoreFiles] Refreshed transactionSuggestions on ${filesRescored} file(s) ` +
        `across ${partnersProcessed} partner(s) for user ${userId}`
    );
  }

  return { partnersProcessed, filesRescored };
}
