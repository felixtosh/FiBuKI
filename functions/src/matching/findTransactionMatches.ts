/**
 * Cloud Function: Find Transaction Matches for File (Callable)
 *
 * Called from the UI when user opens the "Connect Transaction to File" dialog.
 * Scores transactions server-side using the same algorithm as auto-matching.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readDismissedTransactionIds } from "./dismissedTransactions";
import {
  SCORING_CONFIG,
  scoreTransaction,
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
}

interface FindTransactionMatchesResponse {
  matches: TransactionMatchResult[];
  totalCandidates: number;
}

// === Helper Functions ===

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

/**
 * Check if transaction name/partner matches search query
 */
function matchesSearchQuery(
  txData: FirebaseFirestore.DocumentData,
  query: string
): boolean {
  const lowerQuery = query.toLowerCase();
  const name = (txData.name || "").toLowerCase();
  const partner = (txData.partner || "").toLowerCase();
  const reference = (txData.reference || "").toLowerCase();

  return (
    name.includes(lowerQuery) ||
    partner.includes(lowerQuery) ||
    reference.includes(lowerQuery)
  );
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
    let fileData: {
      extractedAmount?: number | null;
      extractedCurrency?: string | null;
      extractedDate?: Timestamp | null;
      extractedPartner?: string | null;
      extractedIban?: string | null;
      extractedText?: string | null;
      partnerId?: string | null;
    };

    // Pairs the file has had dismissed. Only knowable on the fileId path — a
    // caller passing raw fileInfo has no stored document to carry them.
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

      dismissedIds = readDismissedTransactionIds(docData);

      fileData = {
        extractedAmount: docData.extractedAmount,
        extractedCurrency: docData.extractedCurrency,
        extractedDate: docData.extractedDate,
        extractedPartner: docData.extractedPartner,
        extractedIban: docData.extractedIban,
        extractedText: docData.extractedText,
        partnerId: docData.partnerId,
      };
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
        .limit(1000) // Higher limit for search
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

    // Fetch partner aliases if file has an assigned partner
    let partnerAliases: string[] = [];
    if (fileData.partnerId) {
      try {
        const partnerDoc = await db
          .collection("partners")
          .doc(fileData.partnerId)
          .get();
        if (partnerDoc.exists) {
          const partnerData = partnerDoc.data()!;
          partnerAliases = [
            partnerData.name,
            ...(partnerData.aliases || []),
          ].filter(Boolean);
        }
      } catch (error) {
        console.warn("[FindMatches] Failed to fetch partner aliases:", error);
      }
    }

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

      // Apply search query filter if provided
      if (searchQuery && !matchesSearchQuery(doc.data(), searchQuery)) {
        return false;
      }

      return true;
    });

    const totalCandidates = candidates.length;

    // Score each transaction
    const allScores: TransactionMatchScore[] = candidates.map((doc) => {
      const txData = doc.data();
      return scoreTransaction(
        {
          extractedAmount: fileData.extractedAmount,
          extractedCurrency: fileData.extractedCurrency,
          extractedDate: fileData.extractedDate,
          extractedPartner: fileData.extractedPartner,
          extractedIban: fileData.extractedIban,
          extractedText: fileData.extractedText,
          partnerId: fileData.partnerId,
        },
        {
          id: doc.id,
          amount: txData.amount,
          date: txData.date,
          currency: txData.currency,
          // Carries the bank-stated original amount for #112.
          _original: txData._original,
          name: txData.name,
          partner: txData.partner,
          partnerName: txData.partnerName,
          partnerId: txData.partnerId,
          partnerIban: txData.partnerIban,
          reference: txData.reference,
        },
        partnerAliases
      );
    });

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
