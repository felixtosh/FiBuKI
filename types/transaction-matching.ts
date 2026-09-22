/**
 * Types for server-side transaction matching
 *
 * These types are used by the frontend to call the
 * findTransactionMatchesForFile Cloud Function.
 */

// === Match Sources ===

export type TransactionMatchSource =
  | "amount_exact"
  | "amount_close"
  | "date_exact"
  | "date_close"
  | "partner"
  | "iban"
  | "reference"
  | "precision_hint"
  /** Scored against the Transaction's Remainder, not its full amount (#239). */
  | "amount_remainder";

// === Score Breakdown ===

export interface ScoreBreakdown {
  amount: number;
  date: number;
  partner: number;
  iban: number;
  reference: number;
  hint: number;
}

// === Request Types ===

export interface FileMatchingInfo {
  extractedAmount?: number | null;
  extractedDate?: string | null; // ISO date string
  extractedPartner?: string | null;
  extractedIban?: string | null;
  extractedText?: string | null;
  partnerId?: string | null;
}

export interface FindTransactionMatchesRequest {
  /** File ID to fetch data from Firestore */
  fileId?: string;
  /** OR provide file info inline (for real-time matching without saved file) */
  fileInfo?: FileMatchingInfo;
  /** Transaction IDs to exclude (already connected) */
  excludeTransactionIds?: string[];
  /** Optional text search query to filter results */
  searchQuery?: string;
  /** Max results to return (default 20) */
  limit?: number;
}

// === Response Types ===

export interface TransactionMatchPreview {
  date: string; // ISO date string
  amount: number;
  currency: string;
  name: string;
  partner: string | null;
}

export interface TransactionMatchResult {
  transactionId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  breakdown: ScoreBreakdown;
  preview: TransactionMatchPreview;
}

export interface FindTransactionMatchesResponse {
  matches: TransactionMatchResult[];
  totalCandidates: number;
}

// === Config (mirrors server config) ===

export const TRANSACTION_MATCH_CONFIG = {
  /** Minimum confidence for auto-matching (creates connection) */
  AUTO_MATCH_THRESHOLD: 85,
  /** Minimum confidence to show as suggestion (highlighted in UI) */
  SUGGESTION_THRESHOLD: 50,
  /** Days to search before/after file date */
  DATE_RANGE_DAYS: 30,
  /** Max results to return */
  MAX_RESULTS: 20,
};

// === Helper Functions ===

/**
 * Get human-readable label for a match source
 */
export function getMatchSourceLabel(source: TransactionMatchSource): string {
  switch (source) {
    case "amount_exact":
      return "Exact Amount";
    case "amount_close":
      return "Close Amount";
    case "date_exact":
      return "Same Date";
    case "date_close":
      return "Close Date";
    case "partner":
      return "Partner Match";
    case "iban":
      return "IBAN Match";
    case "reference":
      return "Reference Match";
    case "precision_hint":
      return "Search Hint";
    case "amount_remainder":
      return "Remainder";
    default:
      return source;
  }
}

/**
 * Check if a match is above the suggestion threshold
 */
export function isSuggestedMatch(match: TransactionMatchResult): boolean {
  return match.confidence >= TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD;
}

/**
 * Check if a match would be auto-matched
 */
export function isAutoMatch(match: TransactionMatchResult): boolean {
  return match.confidence >= TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD;
}
