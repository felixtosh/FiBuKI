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
  /** Booked on the File's Debit Date or within its settlement lag (#136). */
  | "debit_date"
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

/**
 * A File that is not stored yet, in the stored File's own field names, dates
 * as ISO strings. The server reads it through the matcher's assembly (#613),
 * so every field it scores counts.
 */
export interface FileMatchingInfo {
  extractedAmount?: number | null;
  extractedTipAmount?: number | null;
  extractedCurrency?: string | null;
  extractedDate?: string | null; // ISO date string
  extractedDueDate?: string | null; // ISO date string
  extractedDebitDate?: string | null; // ISO date string
  extractedPartner?: string | null;
  extractedIban?: string | null;
  extractedText?: string | null;
  extractedInvoiceNumber?: string | null;
  partnerId?: string | null;
  precisionSearchHint?: { transactionId?: string } | null;
  documentType?: string | null;
}

/** Why a pair is held back from suggestions; only a search shows it (#613). */
export type HeldBackReason = "rejected" | "over-quota";

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
  /** Set only in a search: the pair is held back from suggestions and auto-connect. */
  hidden?: HeldBackReason;
  /**
   * What the Files already on this Transaction explain, as the scorer read it
   * (#239, #243). Absent when no connected File explains anything.
   */
  coverage?: TransactionMatchCoverage;
}

export interface TransactionMatchCoverage {
  documentedAmount: number;
  remainder: number;
  isCovered: boolean;
  againstRemainder: boolean;
}

export interface FindTransactionMatchesResponse {
  matches: TransactionMatchResult[];
  totalCandidates: number;
  /** Set when the File is never matched: why the list is empty. */
  ineligible?: "deleted" | "copy" | "not-invoice" | "foreign-recipient";
}

// === The mirror: File matches for a Transaction (#555) ===

export interface FindFileMatchesRequest {
  transactionId: string;
  /** Typed search text. Lifts the date window and shows held-back pairs, marked. */
  searchQuery?: string;
  limit?: number;
}

export interface FileMatchResult {
  fileId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  breakdown: ScoreBreakdown;
  /** The amount was judged against the Transaction's Remainder (#239). */
  scoredAgainstRemainder: boolean;
  /** Set only in a search: the pair is held back from suggestions and auto-connect. */
  hidden?: HeldBackReason;
}

export interface FindFileMatchesResponse {
  matches: FileMatchResult[];
  totalCandidates: number;
  /** Files held back because a Rejection names this pair; none in a search. */
  rejectedFileIds: string[];
}

// === Config (mirrors server config) ===

export const TRANSACTION_MATCH_CONFIG = {
  /** Minimum confidence for auto-matching (creates connection) */
  AUTO_MATCH_THRESHOLD: 85,
  /** Minimum confidence to show as suggestion (highlighted in UI) */
  SUGGESTION_THRESHOLD: 50,
  /** Max results to return */
  MAX_RESULTS: 20,
};

// === Helper Functions ===

export type IneligibleReason = NonNullable<FindTransactionMatchesResponse["ineligible"]>;

/** The `connect` message key saying why a File is never matched (#613). */
export function ineligibleKey(
  reason: IneligibleReason
): "ineligible.deleted" | "ineligible.copy" | "ineligible.notInvoice" | "ineligible.foreignRecipient" {
  if (reason === "not-invoice") return "ineligible.notInvoice";
  if (reason === "foreign-recipient") return "ineligible.foreignRecipient";
  return reason === "copy" ? "ineligible.copy" : "ineligible.deleted";
}

/** The `connect` message key labelling a pair a search shows although it is held back (#613). */
export function heldBackKey(reason: HeldBackReason): "heldBack.rejected" | "heldBack.overQuota" {
  return reason === "rejected" ? "heldBack.rejected" : "heldBack.overQuota";
}

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
    case "debit_date":
      return "Debit Date";
    default:
      return source;
  }
}

/**
 * Check if a match is above the suggestion threshold
 */
export function isSuggestedMatch(match: { confidence: number; hidden?: HeldBackReason }): boolean {
  // A held-back pair a search shows is never a suggestion (#613).
  return !match.hidden && match.confidence >= TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD;
}

/**
 * Check if a match would be auto-matched
 */
export function isAutoMatch(match: TransactionMatchResult): boolean {
  return match.confidence >= TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD;
}
