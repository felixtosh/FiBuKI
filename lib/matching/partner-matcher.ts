/**
 * Partner matching utilities
 *
 * NOTE: Actual partner matching logic lives server-side in Cloud Functions.
 * This file only contains utility functions for UI display.
 *
 * Server-side matching: functions/src/utils/partner-matcher.ts
 * Pattern learning: functions/src/matching/learnPartnerPatterns.ts
 */

import { MatchSource } from "@/types/partner";

/**
 * Normalize German umlauts and special characters for matching
 * Banks often transliterate: ä→ae, ö→oe, ü→ue, ß→ss
 */
function normalizeUmlauts(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

/**
 * Match a glob-style pattern against text
 * Supports * as wildcard (matches any characters)
 * Normalizes German umlauts so "häusler" matches "haeusler"
 */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern || !text) return false;

  // Normalize both for umlaut-insensitive matching
  const normalizedText = normalizeUmlauts(text);
  const normalizedPattern = normalizeUmlauts(pattern);

  // Convert glob to regex: escape special chars, then replace * with .*
  const regexPattern = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
    .replace(/\*/g, ".*"); // * -> .*

  try {
    return new RegExp(`^${regexPattern}$`).test(normalizedText);
  } catch {
    return false;
  }
}

/**
 * Determine if a match should be auto-applied (≥89% confidence)
 * Matches server-side threshold in functions/src/utils/partner-matcher.ts
 */
export function shouldAutoApply(confidence: number): boolean {
  return confidence >= 89;
}

/**
 * Get confidence tier for display
 */
export function getConfidenceTier(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 90) return "high";
  if (confidence >= 75) return "medium";
  return "low";
}

/**
 * Get confidence tier color for UI
 */
export function getConfidenceColor(confidence: number): string {
  if (confidence >= 90) return "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300";
  if (confidence >= 75) return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300";
}

/**
 * Get source label for display
 */
export function getSourceLabel(source: MatchSource): string {
  switch (source) {
    case "iban":
      return "IBAN Match";
    case "vatId":
      return "VAT Match";
    case "website":
      return "Website Match";
    case "name":
      return "Name Match";
    case "pattern":
      return "Pattern Match";
    case "manual":
      return "Manual";
    default:
      return source;
  }
}
