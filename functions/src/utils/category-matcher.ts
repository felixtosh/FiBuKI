/**
 * Server-side no-receipt category matching utilities
 *
 * Categories match ONLY by partner - patterns are learned on partners, not categories.
 * When a transaction has a partnerId that's in the category's matchedPartnerIds,
 * the category is suggested.
 */

import { Timestamp } from "firebase-admin/firestore";

// ============ Types ============

// Local type definitions for partner resolution (mirrors types/partner.ts)
// Defined locally to avoid rootDir issues with importing from parent types folder

export type PartnerResolutionType = "file_required" | "no_receipt" | "mixed" | "unknown";

export interface PartnerResolutionStats {
  fileCount: number;
  noReceiptCount: number;
  updatedAt: Timestamp;
}

export interface PartnerResolutionPreference {
  type: PartnerResolutionType;
  confidence: number;
  preferredNoReceiptCategoryId?: string | null;
  preferredNoReceiptCategoryTemplateId?: NoReceiptCategoryId | null;
  stats: PartnerResolutionStats;
}

export type NoReceiptCategoryId =
  | "bank-fees"
  | "interest"
  | "internal-transfers"
  | "payment-provider-settlements"
  | "taxes-government"
  | "payroll"
  | "private-personal"
  | "zero-value"
  | "receipt-lost";

export interface CategoryData {
  id: string;
  userId: string;
  templateId: NoReceiptCategoryId;
  name: string;
  matchedPartnerIds: string[];
  /** Number of transactions assigned to this category */
  transactionCount: number;
  isActive: boolean;
}

export interface TransactionData {
  id: string;
  partner: string | null;
  partnerId: string | null;
  name: string;
  reference: string | null;
  /** Already has a no-receipt category */
  noReceiptCategoryId: string | null;
  /** Has files attached */
  fileIds: string[];
}

export interface CategorySuggestion {
  categoryId: string;
  templateId: NoReceiptCategoryId;
  confidence: number;
  /** Categories match only by partner (patterns are learned on partners, not categories) */
  source: "partner";
}

// ============ Thresholds ============

export const CATEGORY_MATCH_CONFIG = {
  /** Minimum confidence to show as suggestion */
  SUGGESTION_THRESHOLD: 60,
  /** Minimum confidence for auto-assignment */
  AUTO_APPLY_THRESHOLD: 89,
  /** Base confidence for partner match */
  PARTNER_MATCH_CONFIDENCE: 89,
  /** Maximum suggestions to return */
  MAX_SUGGESTIONS: 3,
  /** Maximum usage-based confidence boost (applied logarithmically) */
  USAGE_BOOST_MAX: 10,
  /** Boost when partner has no file source patterns (likely no-receipt partner) */
  NO_FILE_PATTERNS_BOOST: 8,
};

/**
 * Options for category matching with context about partners
 */
export interface CategoryMatchOptions {
  /**
   * Map of partnerId -> number of file source patterns.
   * Partners with 0 or no entry are boosted (likely no-receipt partners).
   */
  partnerFilePatternCounts?: Map<string, number>;

  /**
   * Map of partnerId -> PartnerResolutionPreference.
   * Partners with "no_receipt" preference get boosted confidence.
   */
  partnerResolutionPreferences?: Map<string, PartnerResolutionPreference>;
}

// ============ Matching Logic ============

/**
 * Match a transaction against all categories.
 * Returns suggestions sorted by confidence (highest first).
 *
 * @param transaction - The transaction to match
 * @param categories - All user categories to match against
 * @param categoryManualRemovals - Map of categoryId -> Set of transactionIds that were manually removed
 * @param options - Optional context for improved matching (partner file patterns)
 */
export function matchTransactionToCategories(
  transaction: TransactionData,
  categories: CategoryData[],
  categoryManualRemovals?: Map<string, Set<string>>,
  options?: CategoryMatchOptions
): CategorySuggestion[] {
  const suggestions: CategorySuggestion[] = [];

  for (const category of categories) {
    // Skip receipt-lost - it requires explicit user action
    if (category.templateId === "receipt-lost") {
      continue;
    }

    // Skip inactive categories
    if (!category.isActive) {
      continue;
    }

    // Skip if transaction was manually removed from this category
    if (categoryManualRemovals) {
      const removals = categoryManualRemovals.get(category.id);
      if (removals && removals.has(transaction.id)) {
        continue;
      }
    }

    const suggestion = matchSingleCategory(transaction, category, options);
    if (suggestion) {
      suggestions.push(suggestion);
    }
  }

  // Sort by confidence (highest first)
  suggestions.sort((a, b) => b.confidence - a.confidence);

  // Return top suggestions
  return suggestions.slice(0, CATEGORY_MATCH_CONFIG.MAX_SUGGESTIONS);
}

/**
 * Calculate usage-based confidence boost.
 * Uses logarithmic scaling so early uses have bigger impact than later uses.
 * E.g., going from 0->10 transactions gives ~6 points, 10->100 gives ~3 more.
 */
function calculateUsageBoost(transactionCount: number): number {
  if (!transactionCount || transactionCount <= 0) return 0;
  // Log10 scale: 10 txns = 5 points, 100 txns = 8 points, 1000 txns = 10 points (capped)
  const boost = Math.log10(transactionCount + 1) * 5;
  return Math.min(boost, CATEGORY_MATCH_CONFIG.USAGE_BOOST_MAX);
}

/**
 * Check if partner has file source patterns.
 * Partners without file patterns are more likely to be no-receipt partners.
 */
function partnerHasNoFilePatterns(
  partnerId: string | null,
  partnerFilePatternCounts?: Map<string, number>
): boolean {
  if (!partnerId || !partnerFilePatternCounts) return false;
  const count = partnerFilePatternCounts.get(partnerId);
  // Partner found in map with 0 patterns = definitely no file patterns
  // Partner not in map = we don't know, assume has patterns (no boost)
  return count !== undefined && count === 0;
}

/**
 * Match a transaction against a single category.
 * Returns null if no match found above threshold.
 *
 * Categories match ONLY by partner. Confidence boosting:
 * 1. Base confidence: 89% for partner match
 * 2. Usage boost: +0-10 based on category's transactionCount (logarithmic)
 * 3. No-file-patterns boost: +8 if partner has no file source patterns
 * 4. Resolution preference boost: +0-9 if partner typically resolves with no-receipt
 */
function matchSingleCategory(
  transaction: TransactionData,
  category: CategoryData,
  options?: CategoryMatchOptions
): CategorySuggestion | null {
  // Categories only match by partner
  const partnerMatch =
    transaction.partnerId &&
    category.matchedPartnerIds.includes(transaction.partnerId);

  if (!partnerMatch) {
    return null;
  }

  let confidence = CATEGORY_MATCH_CONFIG.PARTNER_MATCH_CONFIDENCE;

  // Usage boost: categories used more often rank higher
  const usageBoost = calculateUsageBoost(category.transactionCount);
  confidence += usageBoost;

  // No-file-patterns boost: if partner doesn't typically have files, boost category match
  if (
    partnerHasNoFilePatterns(
      transaction.partnerId,
      options?.partnerFilePatternCounts
    )
  ) {
    confidence += CATEGORY_MATCH_CONFIG.NO_FILE_PATTERNS_BOOST;
  }

  // Resolution preference boost: if partner typically resolves with no-receipt, boost
  if (transaction.partnerId && options?.partnerResolutionPreferences) {
    const pref = options.partnerResolutionPreferences.get(transaction.partnerId);
    if (pref && pref.type === "no_receipt" && pref.confidence > 0) {
      // Boost proportional to resolution confidence (up to +9 at 95% confidence)
      const resolutionBoost = Math.round(pref.confidence * 0.1);
      confidence += resolutionBoost;
    }
  }

  // Cap at 100
  confidence = Math.min(100, confidence);

  // Return suggestion if above threshold
  if (confidence >= CATEGORY_MATCH_CONFIG.SUGGESTION_THRESHOLD) {
    return {
      categoryId: category.id,
      templateId: category.templateId,
      confidence,
      source: "partner",
    };
  }

  return null;
}

/**
 * Check if a category suggestion should be auto-applied.
 */
export function shouldAutoApplyCategory(confidence: number): boolean {
  return confidence >= CATEGORY_MATCH_CONFIG.AUTO_APPLY_THRESHOLD;
}

/**
 * Check if a transaction is eligible for category matching.
 * Skip if already has category or has files attached.
 */
export function isEligibleForCategoryMatching(
  transaction: TransactionData
): boolean {
  // Already has a category
  if (transaction.noReceiptCategoryId) {
    return false;
  }

  // Has files attached
  if (transaction.fileIds && transaction.fileIds.length > 0) {
    return false;
  }

  return true;
}
