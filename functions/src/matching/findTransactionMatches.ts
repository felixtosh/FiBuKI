/**
 * Cloud Function: Find Transaction Matches for File (Callable)
 *
 * Called from the UI when user opens the "Connect Transaction to File" dialog.
 * Scores transactions server-side using the same algorithm as auto-matching.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readDismissedTransactionIds } from "./dismissedTransactions";
import { liveCopyIds } from "../files/copyOps";
import { loadDocumentedAmounts } from "./documentedAmounts";
import { loadScoringEcbRates } from "./scoringEcbRates";
import { deriveCoverage } from "./coverage";
import { matchesTransactionSearch } from "./transactionSearch";
import {
  SCORING_CONFIG,
  scoreFileAgainstTransactions,
  loadPartnerScoringContext,
  formatScoreBreakdown,
  TransactionMatchScore,
  TransactionMatchSource,
  ScoreBreakdown,
} from "./transactionScoring";

const db = getFirestore();

// === Request/Response Types ===

interface FileInfo {
  extractedAmount?: number | null;
  extractedCurrency?: string | null;
  extractedDate?: string | null; // ISO date string
  extractedPartner?: string | null;
  extractedIban?: string | null;
  extractedText?: string | null;
  /** #137: the needle for the invoice-number match source. */
  extractedInvoiceNumber?: string | null;
  partnerId?: string | null;
}

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

/**
 * Convert ISO string to Firestore Timestamp
 */
function toTimestamp(isoString: string): Timestamp {
  return Timestamp.fromDate(new Date(isoString));
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
    // The stored File as-is on the fileId path, so every field
    // toFileMatchingData reads reaches this scorer (#308, #327).
    let fileData: FirebaseFirestore.DocumentData;

    let dismissedIds = new Set<string>();

    if (fileId) {
      // Fetch from Firestore
      const fileDoc = await db.collection("files").doc(fileId).get();
      if (!fileDoc.exists) {
        throw new HttpsError("not-found", `File not found: ${fileId}`);
      }

      const docData = fileDoc.data()!;

      // Verify ownership
      if (docData.userId !== userId) {
        throw new HttpsError("permission-denied", "Cannot access this file");
      }

      // Skip "Not Invoice" files - return empty matches
      if (docData.isNotInvoice === true) {
        console.log(`[FindMatches] File ${fileId} is not an invoice, returning empty`);
        return { matches: [], totalCandidates: 0 };
      }

      // #162: a Copy is never proposed as a Match.
      if ((await liveCopyIds(db, [{ id: fileId, data: docData }])).has(fileId)) {
        console.log(`[FindMatches] File ${fileId} is a Copy, returning empty`);
        return { matches: [], totalCandidates: 0 };
      }

      dismissedIds = readDismissedTransactionIds(docData);

      fileData = docData;
    } else {
      // Use provided fileInfo
      fileData = {
        extractedAmount: fileInfo!.extractedAmount,
        extractedCurrency: fileInfo!.extractedCurrency,
        extractedDate: fileInfo!.extractedDate
          ? toTimestamp(fileInfo!.extractedDate)
          : null,
        extractedPartner: fileInfo!.extractedPartner,
        extractedIban: fileInfo!.extractedIban,
        extractedText: fileInfo!.extractedText,
        extractedInvoiceNumber: fileInfo!.extractedInvoiceNumber,
        partnerId: fileInfo!.partnerId,
      };
    }

    const t0 = Date.now();

    // === Query Candidate Transactions ===
    let transactions: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    let dateRangeStr = "";

    // When user provides a search query, don't filter by date - they want to find specific transactions
    // This allows finding transactions from months before/after the invoice date
    if (searchQuery) {
      // User searching - query all transactions without date filter
      dateRangeStr = "all (user search)";
      const snapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .orderBy("date", "desc")
        .limit(1000) // Higher limit for search. Known limit (#183): an amount older than these 1000 cannot be found
        .get();

      transactions = snapshot.docs;
    } else if (fileData.extractedDate) {
      // Auto-matching - query within date range
      const centerDate = fileData.extractedDate.toDate();
      const startDate = new Date(centerDate);
      startDate.setDate(startDate.getDate() - SCORING_CONFIG.DATE_RANGE_DAYS);
      const endDate = new Date(centerDate);
      endDate.setDate(endDate.getDate() + SCORING_CONFIG.DATE_RANGE_DAYS);
      dateRangeStr = `${startDate.toISOString().split("T")[0]} to ${endDate.toISOString().split("T")[0]}`;

      const snapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("date", ">=", Timestamp.fromDate(startDate))
        .where("date", "<=", Timestamp.fromDate(endDate))
        .orderBy("date", "desc")
        .limit(500)
        .get();

      transactions = snapshot.docs;
    } else {
      // No date? Query recent transactions
      dateRangeStr = "recent (no file date)";
      const snapshot = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .orderBy("date", "desc")
        .limit(200)
        .get();

      transactions = snapshot.docs;
    }

    console.log(
      `[FindMatches] Found ${transactions.length} candidate transactions (${dateRangeStr})`
    );

    // === Filter and Score ===
    const excludeSet = new Set(excludeTransactionIds);

    // Same derivation as auto-matching, not a copy of it (#138): this
    // dialog's scores have to be the ones matchFileTransactions produced,
    // including the linked Global Partner's brand aliases.
    const partner = await loadPartnerScoringContext(db, fileData.partnerId, userId);

    // Filter candidates
    let candidates = transactions.filter((doc) => {
      // Exclude already connected
      if (excludeSet.has(doc.id)) return false;

      // Exclude pairs this file already dismissed. Callers auto-connect the
      // top result at AUTO_MATCH_THRESHOLD, so an unfiltered refresh reconnects
      // what was just rejected. An explicit search is exempt: it is the only
      // way back to a dismissed pair by hand, and dismissal is not meant to be
      // irreversible.
      if (!searchQuery && dismissedIds.has(doc.id)) return false;

      // Apply search query filter if provided: text OR amount (#183), the
      // same predicate the dialogs filter with on the client.
      if (searchQuery && !matchesTransactionSearch(doc.data(), searchQuery)) {
        return false;
      }

      return true;
    });

    const totalCandidates = candidates.length;

    // What the Files already on each candidate explain (#239). The trigger
    // resolves its Remainders through the same helper, so this dialog and the
    // stored suggestions cannot disagree about which figure is open.
    const [documentedAmounts, ecbRates] = await Promise.all([
      loadDocumentedAmounts(candidates.map((c) => c.id), fileId),
      loadScoringEcbRates(db, [fileData.extractedCurrency], candidates),
    ]);

    // Score each transaction — the trigger's own input assembly (#308, #327).
    const allScores: TransactionMatchScore[] = scoreFileAgainstTransactions(
      fileData,
      candidates,
      partner,
      documentedAmounts,
      ecbRates
    );

    // Sort by confidence and take top results
    // Include ALL results (not just above threshold) so UI can show full list
    const matches = allScores
      .sort((a, b) => b.confidence - a.confidence)
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
