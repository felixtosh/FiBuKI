/**
 * Cloud Function: Find Transaction Matches for File (Callable)
 *
 * Called from the UI when user opens the "Connect Transaction to File" dialog.
 * Scores transactions server-side using the same algorithm as auto-matching.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { deriveCoverage } from "./coverage";
import {
  transactionsForFile,
  unsavedFileData,
  type HiddenReason,
  type IneligibleReason,
  type MatcherFile,
} from "./matcher";
import {
  SCORING_CONFIG,
  formatScoreBreakdown,
  TransactionMatchSource,
  ScoreBreakdown,
} from "./transactionScoring";

const db = getFirestore();

// === Request/Response Types ===

/**
 * A File that is not stored yet, in the stored File's own field names, dates
 * as ISO strings. Read through the matcher's assembly (`unsavedFileData`),
 * so every field the scorer reads counts here too (#613).
 */
type FileInfo = Record<string, unknown>;

interface FindTransactionMatchesRequest {
  /** File ID to fetch data from Firestore */
  fileId?: string;
  /** OR provide file info inline (for real-time matching without saved file) */
  fileInfo?: FileInfo;
  /** Transaction IDs to exclude (already connected) */
  excludeTransactionIds?: string[];
  /** Optional text search query to filter results */
  searchQuery?: string;
  /** Max results to return (default 20) */
  limit?: number;
}

interface TransactionMatchResult {
  transactionId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  breakdown: ScoreBreakdown;
  preview: {
    date: string; // ISO date for JSON serialization
    amount: number;
    currency: string;
    name: string;
    partner: string | null;
  };
  /** Set only in a User's search: the pair is held back from suggestions and auto-connect. */
  hidden?: HiddenReason;
  /**
   * What the Files already on this Transaction explain, as the scorer read it
   * (#239, #243). The connect overlay prints the Remainder from here so the
   * row shows the figure this pair was scored against, not a second sum.
   * Absent when no connected File explains anything.
   */
  coverage?: MatchCoverage;
}

interface MatchCoverage {
  documentedAmount: number;
  remainder: number;
  isCovered: boolean;
  againstRemainder: boolean;
}

interface FindTransactionMatchesResponse {
  matches: TransactionMatchResult[];
  totalCandidates: number;
  /** Set when the File is never matched: why the list is empty. */
  ineligible?: IneligibleReason;
}

// === Helper Functions ===

/** The scorer's own Coverage for one candidate, for the row to print (#243). */
function coverageOf(
  transactionAmount: number,
  documentedAmount: number | undefined
): { coverage?: MatchCoverage } {
  if (!documentedAmount) return {};
  const c = deriveCoverage(transactionAmount, documentedAmount);
  return {
    coverage: {
      documentedAmount: c.documentedAmount,
      remainder: c.remainder,
      isCovered: c.isCovered,
      againstRemainder: c.againstRemainder,
    },
  };
}

/**
 * Convert Firestore Timestamp to ISO string for JSON serialization
 */
function toISOString(timestamp: Timestamp): string {
  return timestamp.toDate().toISOString();
}

// === Main Callable Function ===

export const findTransactionMatchesForFile = onCall<FindTransactionMatchesRequest>(
  {
    region: "europe-west1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (request): Promise<FindTransactionMatchesResponse> => {
    // === Auth Check ===
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;

    const { fileId, fileInfo, excludeTransactionIds = [], searchQuery, limit = SCORING_CONFIG.MAX_RESULTS } = request.data;

    // === Validate Input ===
    if (!fileId && !fileInfo) {
      throw new HttpsError(
        "invalid-argument",
        "Must provide either fileId or fileInfo"
      );
    }

    // === Get File Data ===
    // The stored File as-is on the fileId path, so every field the scorer
    // reads reaches it (#308, #327); an unsaved File through the same
    // assembly (#613).
    let file: MatcherFile;

    if (fileId) {
      const fileDoc = await db.collection("files").doc(fileId).get();
      if (!fileDoc.exists) {
        throw new HttpsError("not-found", `File not found: ${fileId}`);
      }
      const docData = fileDoc.data()!;
      if (docData.userId !== userId) {
        throw new HttpsError("permission-denied", "Cannot access this file");
      }
      file = { id: fileId, data: docData };
    } else {
      file = { id: null, data: unsavedFileData(fileInfo ?? {}) };
    }

    const t0 = Date.now();

    // Candidates, Rejections, the date window and the scores are the
    // matcher's (#613): what this dialog ranks is what the trigger stores.
    // A search lifts the window and shows held-back pairs, marked: it is the
    // way back to one by hand.
    const result = await transactionsForFile(db, userId, file, {
      search: searchQuery,
      excludeTransactionIds,
    });
    if (result.ineligible) {
      console.log(`[FindMatches] File ${fileId ?? "(unsaved)"} is never matched: ${result.ineligible}`);
      return { matches: [], totalCandidates: 0, ineligible: result.ineligible };
    }
    const { documentedAmounts, totalCandidates } = result;

    // Sort by confidence and take top results
    // Include ALL results (not just above threshold) so UI can show full list
    const matches = result.matches
      .slice(0, limit)
      .map((m): TransactionMatchResult => ({
        transactionId: m.transactionId,
        confidence: m.confidence,
        matchSources: m.matchSources,
        breakdown: m.breakdown,
        preview: {
          date: toISOString(m.preview.date),
          amount: m.preview.amount,
          currency: m.preview.currency,
          name: m.preview.name,
          partner: m.preview.partner,
        },
        ...(m.hidden ? { hidden: m.hidden } : {}),
        ...coverageOf(m.preview.amount, documentedAmounts.get(m.transactionId)),
      }));

    const elapsed = Date.now() - t0;

    // Log summary
    const aboveThreshold = matches.filter(
      (m) => m.confidence >= SCORING_CONFIG.SUGGESTION_THRESHOLD
    ).length;
    console.log(
      `[FindMatches] Returning ${matches.length} matches (${aboveThreshold} above ${SCORING_CONFIG.SUGGESTION_THRESHOLD}% threshold) in ${elapsed}ms`
    );

    // Log top match for debugging
    if (matches.length > 0) {
      const top = matches[0];
      console.log(
        `[FindMatches] Top match: ${top.confidence}% - "${top.preview.name}" | ${formatScoreBreakdown(top.breakdown)}`
      );
    }

    return {
      matches,
      totalCandidates,
    };
  }
);
