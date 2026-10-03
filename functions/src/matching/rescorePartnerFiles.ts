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
 * never auto-connect. `scoreTransaction` is reused the way
 * `rescoreFileConnections.ts` does — via the shared assembly, one Partner
 * context per Partner, batched writes — so the sweep cannot drift from what
 * the initial match computes.
 *
 * Deliberately additive: this writes `transactionSuggestions` and a timestamp
 * and nothing else. No connection is created, no Partner assignment is
 * cleared, and the pipeline flags (`transactionMatchComplete`) are untouched,
 * so the file-side trigger does not re-fire off these writes.
 */

import { Timestamp } from "firebase-admin/firestore";
import {
  SCORING_CONFIG,
  TransactionMatchSource,
  loadPartnerScoringContext,
  scoreFileAgainstTransactions,
} from "./transactionScoring";
import { readDismissedTransactionIds } from "./dismissedTransactions";
import { liveCopyIds } from "../files/copyOps";
import { isFileRejected } from "./rejectedFiles";
import { toDateSafe } from "../utils/toDateSafe";

/** Firestore batch write cap is 500; chunk with headroom. */
const BATCH_CHUNK_SIZE = 400;
/** Cap per Partner — the sweep is a refresh, not a migration. */
const MAX_FILES_PER_PARTNER = 200;
/** Candidate pool cap over the union window of all files being re-scored. */
const MAX_CANDIDATE_TRANSACTIONS = 1000;
/** Fallback pool when no File carries an extracted date. */
const MAX_RECENT_TRANSACTIONS = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The stored suggestion shape `matchFileTransactions` writes. */
interface TransactionSuggestion {
  transactionId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  preview: {
    date: Timestamp;
    amount: number;
    currency: string;
    name: string;
    partner: string | null;
  };
}

export interface RescorePartnerFilesResult {
  partnersProcessed: number;
  filesRescored: number;
}

function extractedDateOf(fileData: FirebaseFirestore.DocumentData): Date | null {
  const raw = fileData.extractedDate;
  return raw && typeof raw.toDate === "function" ? raw.toDate() : null;
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

  for (const partnerId of uniquePartnerIds) {
    partnersProcessed++;

    const filesSnapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("partnerId", "==", partnerId)
      .limit(MAX_FILES_PER_PARTNER)
      .get();

    // Unconnected, already through the pipeline, and actually matchable. A
    // File mid-pipeline (`transactionMatchComplete` not yet true) is left to
    // its own trigger rather than raced.
    // #162: a Copy is never proposed as a Match.
    const copies = await liveCopyIds(
      db,
      filesSnapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }))
    );
    const files = filesSnapshot.docs.filter((doc) => {
      const data = doc.data();
      if (data.deletedAt) return false;
      if (copies.has(doc.id)) return false;
      if (data.isNotInvoice === true) return false;
      if (data.foreignRecipient === true) return false;
      if (data.transactionMatchComplete !== true) return false;
      const connected = Array.isArray(data.transactionIds) && data.transactionIds.length > 0;
      return !connected;
    });

    if (files.length === 0) continue;

    // One Partner context per Partner, exactly as the initial match reads it:
    // aliases (own, Global Partner, preset), billing-cycle bands, weights.
    const partner = await loadPartnerScoringContext(db, partnerId, userId);

    // One candidate pool per Partner over the union of the Files' date
    // windows, instead of one query per File. A File without an extracted
    // date is scored against the whole pool.
    const dates = files
      .map((doc) => extractedDateOf(doc.data()))
      .filter((d): d is Date => d !== null);

    let candidates: FirebaseFirestore.QueryDocumentSnapshot[];
    if (dates.length > 0) {
      const startDate = new Date(
        Math.min(...dates.map((d) => d.getTime())) -
          SCORING_CONFIG.DATE_RANGE_DAYS * MS_PER_DAY
      );
      const endDate = new Date(
        Math.max(...dates.map((d) => d.getTime())) +
          SCORING_CONFIG.DATE_RANGE_DAYS * MS_PER_DAY
      );
      const snapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("date", ">=", Timestamp.fromDate(startDate))
        .where("date", "<=", Timestamp.fromDate(endDate))
        .orderBy("date", "desc")
        .limit(MAX_CANDIDATE_TRANSACTIONS)
        .get();
      candidates = snapshot.docs;
      if (snapshot.size >= MAX_CANDIDATE_TRANSACTIONS) {
        console.warn(
          `[RescoreFiles] Candidate pool for partner ${partnerId} hit its cap of ` +
            `${MAX_CANDIDATE_TRANSACTIONS}; files at the window's far edge may be under-scored`
        );
      }
    } else {
      const snapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .orderBy("date", "desc")
        .limit(MAX_RECENT_TRANSACTIONS)
        .get();
      candidates = snapshot.docs;
    }

    let batch = db.batch();
    let pending = 0;

    for (const fileDoc of files) {
      const fileData = fileDoc.data();
      const dismissedIds = readDismissedTransactionIds(fileData);
      const fileDate = extractedDateOf(fileData);

      const eligible = candidates.filter((txDoc) => {
        if (dismissedIds.has(txDoc.id)) return false;
        const txData = txDoc.data();
        if (txData.quotaExceeded) return false;
        if (isFileRejected(txData, fileDoc.id)) return false;
        if (fileDate) {
          const txDate = toDateSafe(txData.date);
          if (!txDate) return false;
          const daysDiff = Math.abs(txDate.getTime() - fileDate.getTime()) / MS_PER_DAY;
          if (daysDiff > SCORING_CONFIG.DATE_RANGE_DAYS) return false;
        }
        return true;
      });

      // Scored against full amounts (no documentedAmounts), the same way
      // rescoreFileConnections.ts reuses the scorer: these are suggestions on
      // unconnected Files, and a Remainder judgement is the connect paths' job.
      const scores = scoreFileAgainstTransactions(fileData, eligible, partner, new Map());

      const suggestions: TransactionSuggestion[] = scores
        .filter((m) => m.confidence >= SCORING_CONFIG.SUGGESTION_THRESHOLD)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, SCORING_CONFIG.MAX_SUGGESTIONS)
        .map((m) => ({
          transactionId: m.transactionId,
          confidence: m.confidence,
          matchSources: m.matchSources,
          preview: m.preview,
        }));

      batch.update(fileDoc.ref, {
        transactionSuggestions: suggestions,
        transactionMatchedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
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
