/**
 * Callable: find File matches for a Transaction (#555).
 *
 * The mirror of findTransactionMatchesForFile. The Connect File window opened
 * from a Transaction used to rank stored Files with the email attachment
 * scorer, which knows nothing of currency, the bank-stated original amount,
 * the tip, the Remainder, Partner aliases or learned weights. So the window
 * and the File's stored suggestions disagreed about the same pair on one
 * screen. This scores every candidate with the matcher's own input assembly,
 * so its Confidence is the one the trigger stores.
 *
 * Takes a Transaction id and nothing about any File: everything scored is
 * read here, from the caller's own records.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { isLiveFile, liveCopyIds } from "../files/copyOps";
import { loadDocumentedAmounts } from "./documentedAmounts";
import { readDismissedTransactionIds } from "./dismissedTransactions";
import { readRejectedFileIds } from "./rejectedFiles";
import { fileSearchMatches } from "./fileSearch";
import { loadScoringEcbRates } from "./scoringEcbRates";
import {
  SCORING_CONFIG,
  isRemainderMatch,
  loadPartnerScoringContext,
  scoreFileAgainstTransactions,
  type PartnerScoringContext,
  type ScoreBreakdown,
  type TransactionMatchSource,
} from "./transactionScoring";
import { toDateSafe } from "../utils/toDateSafe";

interface FindFileMatchesRequest {
  transactionId: string;
  /** Typed search text. Lifts the date gate and the Rejection filter. */
  searchQuery?: string;
  /** Max results (default SCORING_CONFIG.MAX_RESULTS). */
  limit?: number;
}

interface FileMatchResult {
  fileId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  breakdown: ScoreBreakdown;
  /** The amount was judged against the Transaction's Remainder (#239). */
  scoredAgainstRemainder: boolean;
}

interface FindFileMatchesResponse {
  matches: FileMatchResult[];
  totalCandidates: number;
}

/** Upper bound on `limit`, whatever the caller asks for. */
const MAX_LIMIT = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const findFileMatchesForTransactionCallable = createCallable<
  FindFileMatchesRequest,
  FindFileMatchesResponse
>(
  { name: "findFileMatchesForTransaction", timeoutSeconds: 30 },
  async (ctx, request) => {
    const { transactionId } = request;
    if (!transactionId || typeof transactionId !== "string") {
      throw new HttpsError("invalid-argument", "transactionId is required");
    }
    const search = typeof request.searchQuery === "string" ? request.searchQuery.trim() : "";
    const requested = Number(request.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : SCORING_CONFIG.MAX_RESULTS;

    const txDoc = await ctx.db.collection("transactions").doc(transactionId).get();
    // Someone else's Transaction is not-found, not forbidden: an id that
    // exists elsewhere must answer like one that exists nowhere.
    if (!txDoc.exists || txDoc.data()?.userId !== ctx.userId) {
      throw new HttpsError("not-found", "Transaction not found");
    }
    const txData = txDoc.data()!;
    const txDateMs = toDateSafe(txData.date)?.getTime() ?? null;

    // Every File of the caller's, narrowed here rather than in the query: an
    // undated File has no extractedDate at all on some records and a null one
    // on others, and no single query reaches both. The browser already holds
    // this same list.
    const snapshot = await ctx.db.collection("files").where("userId", "==", ctx.userId).get();

    const rejectedHere = readRejectedFileIds(txData);
    const windowMs = SCORING_CONFIG.DATE_RANGE_DAYS * MS_PER_DAY;

    const eligible = snapshot.docs.filter((doc) => {
      const data = doc.data();
      if (!isLiveFile(data) || data.isNotInvoice === true) return false;
      // Already on this Transaction: the window shows it as connected.
      if (Array.isArray(data.transactionIds) && data.transactionIds.includes(transactionId)) {
        return false;
      }
      // An explicit search reaches every File, including dated outside the
      // window and pairs rejected earlier: it is the way back to one by hand.
      if (search) return fileSearchMatches(data, search).length > 0;

      // A Rejection on either side holds without a search.
      if (rejectedHere.has(doc.id)) return false;
      if (readDismissedTransactionIds(data).has(transactionId)) return false;

      // The trigger's own date range, from the other end: the pairs it can
      // store are a File within DATE_RANGE_DAYS of the Transaction, an
      // undated File (scored against recent Transactions), and a File whose
      // precision-search hint names this Transaction.
      const fileDate = toDateSafe(data.extractedDate);
      if (!fileDate || txDateMs === null) return true;
      if (data.precisionSearchHint?.transactionId === transactionId) return true;
      return Math.abs(fileDate.getTime() - txDateMs) <= windowMs;
    });

    // #162: a Copy is never proposed as a Match; its original is.
    const copies = await liveCopyIds(
      ctx.db,
      eligible.map((doc) => ({ id: doc.id, data: doc.data() }))
    );
    const candidates = eligible.filter((doc) => !copies.has(doc.id));

    if (candidates.length === 0) return { matches: [], totalCandidates: 0 };

    // No candidate is connected to this Transaction, so what its connected
    // Files explain is the same figure the trigger reads with the candidate
    // excluded.
    const [documentedAmounts, ecbRates] = await Promise.all([
      loadDocumentedAmounts([transactionId]),
      loadScoringEcbRates(
        ctx.db,
        candidates.map((doc) => doc.data().extractedCurrency),
        [txDoc]
      ),
    ]);

    // One scoring context per Partner, as the trigger reads it per File.
    const partners = new Map<string, Promise<PartnerScoringContext>>();
    const partnerFor = (partnerId: string | null | undefined) => {
      const key = partnerId ?? "";
      if (!partners.has(key)) {
        partners.set(key, loadPartnerScoringContext(ctx.db, partnerId, ctx.userId));
      }
      return partners.get(key)!;
    };

    const scored = await Promise.all(
      candidates.map(async (doc) => {
        const fileData = doc.data();
        const partner = await partnerFor(fileData.partnerId);
        const [match] = scoreFileAgainstTransactions(
          fileData,
          [txDoc],
          partner,
          documentedAmounts,
          ecbRates
        );
        return {
          fileId: doc.id,
          confidence: match.confidence,
          matchSources: match.matchSources,
          breakdown: match.breakdown,
          scoredAgainstRemainder: isRemainderMatch(match),
        };
      })
    );

    return {
      matches: scored.sort((a, b) => b.confidence - a.confidence).slice(0, limit),
      totalCandidates: candidates.length,
    };
  }
);
