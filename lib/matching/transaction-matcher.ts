/**
 * Display helpers for file-to-transaction match results.
 *
 * Scoring itself lives in `functions/src/matching/transactionScoring.ts` and is
 * reached through the `findTransactionMatchesForFile` callable. This module only
 * turns a confidence number and a match source into something renderable.
 */

import { TransactionMatchSource } from "@/types/file";

// === Configuration ===

export const TRANSACTION_MATCH_CONFIG = {
  /** Minimum confidence for auto-matching (creates connection automatically) */
  AUTO_MATCH_THRESHOLD: 85,
  /** Minimum confidence to show as suggestion */
  SUGGESTION_THRESHOLD: 50,
  /** Days to search before/after file date */
  DATE_RANGE_DAYS: 30,
  /** Max suggestions to store per file */
  MAX_SUGGESTIONS: 5,
};

// === Helper Functions ===

/**
 * Determine if a match should be auto-applied
 */
export function shouldAutoMatchTransaction(confidence: number): boolean {
  return confidence >= TRANSACTION_MATCH_CONFIG.AUTO_MATCH_THRESHOLD;
}

/**
 * Get confidence tier for display
 */
export function getTransactionMatchConfidenceTier(
  confidence: number
): "high" | "medium" | "low" {
  if (confidence >= 85) return "high";
  if (confidence >= 70) return "medium";
  return "low";
}

/**
 * Get confidence tier color for UI
 */
export function getTransactionMatchConfidenceColor(confidence: number): string {
  if (confidence >= 85)
    return "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300";
  if (confidence >= 70)
    return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300";
}

/**
 * Get source label for display
 */
export function getTransactionMatchSourceLabel(source: TransactionMatchSource): string {
  switch (source) {
    case "amount_exact":
      return "Exact Amount";
    case "amount_close":
      return "Amount Match";
    case "date_exact":
      return "Same Date";
    case "date_close":
      return "Date Match";
    case "partner":
      return "Partner Match";
    case "iban":
      return "IBAN Match";
    case "reference":
      return "Reference Match";
    default:
      return source;
  }
}

/**
 * Get icon name for match source (for UI)
 */
export function getTransactionMatchSourceIcon(
  source: TransactionMatchSource
): string {
  switch (source) {
    case "amount_exact":
    case "amount_close":
      return "euro"; // or "dollar-sign" depending on locale
    case "date_exact":
    case "date_close":
      return "calendar";
    case "partner":
      return "building";
    case "iban":
      return "credit-card";
    case "reference":
      return "hash";
    default:
      return "check";
  }
}
