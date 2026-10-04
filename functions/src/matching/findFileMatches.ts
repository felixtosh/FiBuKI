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
 * read by the matcher, from the caller's own records.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { filesForTransaction, type HiddenReason } from "./matcher";
import {
  SCORING_CONFIG,
  isRemainderMatch,
  type ScoreBreakdown,
  type TransactionMatchSource,
} from "./transactionScoring";

interface FindFileMatchesRequest {
  transactionId: string;
  /** Typed search text. Lifts the date window and shows held-back pairs, marked. */
  searchQuery?: string;
  /** Max results (default SCORING_CONFIG.MAX_RESULTS). */
  limit?: number;
}

export interface FileMatchResult {
  fileId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  breakdown: ScoreBreakdown;
  /** The amount was judged against the Transaction's Remainder (#239). */
  scoredAgainstRemainder: boolean;
  /** Set only in a User's search: the pair is held back from suggestions and auto-connect. */
  hidden?: HiddenReason;
}

interface FindFileMatchesResponse {
  matches: FileMatchResult[];
  totalCandidates: number;
  /** Files held back because a Rejection names this pair; none in a search. */
  rejectedCount: number;
}

/** Upper bound on `limit`, whatever the caller asks for. */
const MAX_LIMIT = 100;

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

    // Candidates, Rejections, the date window and the scores are the
    // matcher's (#613), so this window ranks what the trigger stores.
    const { matches, totalCandidates, rejectedCount } = await filesForTransaction(ctx.db, ctx.userId, txDoc, {
      search,
    });
    return {
      matches: matches.slice(0, limit).map(
        (m): FileMatchResult => ({
          fileId: m.fileId,
          confidence: m.confidence,
          matchSources: m.matchSources,
          breakdown: m.breakdown,
          scoredAgainstRemainder: isRemainderMatch(m),
          ...(m.hidden ? { hidden: m.hidden } : {}),
        })
      ),
      totalCandidates,
      rejectedCount,
    };
  }
);
