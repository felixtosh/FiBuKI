/**
 * Transaction matching algorithm for files
 *
 * ⚠️ DEPRECATED: Client-side scoring functions are deprecated.
 * All scoring should be done via the server callable `findTransactionMatchesForFile`.
 * See `/lib/operations/file-transaction-matching-ops.ts` for the correct approach.
 *
 * This file is kept for:
 * - UI helper functions (getTransactionMatchConfidenceColor, etc.)
 * - Legacy compatibility during migration
 *
 * Scoring breakdown (for reference):
 * 1. Amount match (0-40 points)
 * 2. Date proximity (0-25 points)
 * 3. Partner overlap (0-25 points)
 * 4. IBAN match (0-10 points)
 * 5. Reference/Invoice ID match (0-5 points + date bonus)
 */

import { TaxFile, TransactionSuggestion, TransactionMatchSource } from "@/types/file";
import { Transaction } from "@/types/transaction";
import { normalizeIban } from "@/lib/import/deduplication";
import { Timestamp } from "firebase/firestore";

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

// === Scoring Breakdown ===

export interface TransactionMatchScore {
  transactionId: string;
  confidence: number; // 0-100
  breakdown: {
    amountScore: number; // 0-40
    dateScore: number; // 0-25
    partnerScore: number; // 0-20
    ibanScore: number; // 0-10
    referenceScore: number; // 0-5
  };
  matchSources: TransactionMatchSource[];
  preview: {
    date: Timestamp;
    amount: number;
    currency: string;
    name: string;
    partner: string | null;
  };
}

// === Main Matching Function ===

/**
 * Score a transaction against a file
 * Returns a match score with breakdown
 *
 * @deprecated Use server callable `findTransactionMatchesForFile` instead.
 * Client-side scoring causes inconsistencies with server-side auto-matching.
 */
export function scoreTransactionMatch(
  file: TaxFile,
  transaction: Transaction
): TransactionMatchScore {
  const breakdown = {
    amountScore: 0,
    dateScore: 0,
    partnerScore: 0,
    ibanScore: 0,
    referenceScore: 0,
  };
  const matchSources: TransactionMatchSource[] = [];

  // 1. Amount scoring (0-40, reduced if currency mismatch)
  if (file.extractedAmount != null) {
    const result = calculateAmountScore(
      file.extractedAmount,
      transaction.amount,
      file.extractedCurrency,
      transaction.currency
    );
    breakdown.amountScore = result.score;
    if (result.source) matchSources.push(result.source);
  }

  // 2. Date scoring (0-25, can get +10 bonus from reference match, boosted for partner matches)
  if (file.extractedDate) {
    const result = calculateDateScore(
      file.extractedDate.toDate(),
      transaction.date.toDate()
    );
    breakdown.dateScore = result.score;
    if (result.source) matchSources.push(result.source);
  }

  // 3. Partner scoring (0-25)
  if (file.partnerId && transaction.partnerId) {
    if (file.partnerId === transaction.partnerId) {
      breakdown.partnerScore = 25;
      matchSources.push("partner");
    }
  }

  // 3b. Date boost for partner matches (recurring transaction disambiguation)
  // When partner matches, date becomes critical for distinguishing monthly invoices.
  if (breakdown.partnerScore >= 15 && file.extractedDate) {
    if (breakdown.dateScore >= 15) {
      // Good date match + partner match: boost date by 50%
      breakdown.dateScore = Math.min(37, Math.round(breakdown.dateScore * 1.5));
    } else if (breakdown.dateScore <= 3) {
      // Poor date match + partner match: likely wrong month, penalize partner score
      breakdown.partnerScore = Math.round(breakdown.partnerScore * 0.6);
    }
  }

  // 4. IBAN scoring (0-10)
  if (file.extractedIban && transaction.partnerIban) {
    const fileIban = normalizeIban(file.extractedIban);
    const txIban = normalizeIban(transaction.partnerIban);
    if (fileIban === txIban) {
      breakdown.ibanScore = 10;
      matchSources.push("iban");
    }
  }

  // 5. Reference/Invoice ID scoring (0-5, with date bonus)
  if (file.extractedText && transaction.reference) {
    const result = calculateReferenceScore(
      file.extractedText,
      transaction.reference,
      breakdown.dateScore
    );
    breakdown.referenceScore = result.score;
    if (result.dateBonus) {
      breakdown.dateScore = Math.min(25, breakdown.dateScore + result.dateBonus);
    }
    if (result.source) matchSources.push(result.source);
  }

  const confidence =
    breakdown.amountScore +
    breakdown.dateScore +
    breakdown.partnerScore +
    breakdown.ibanScore +
    breakdown.referenceScore;

  return {
    transactionId: transaction.id,
    confidence,
    breakdown,
    matchSources,
    preview: {
      date: transaction.date,
      amount: transaction.amount,
      currency: transaction.currency,
      name: transaction.name,
      partner: transaction.partner,
    },
  };
}

// === Individual Scoring Functions ===

/**
 * Calculate amount score (0-40, reduced if currency mismatch)
 * Exact match = 40, within 1% = 38, within 5% = 30, within 10% = 20
 * Currency mismatch applies 50% penalty
 */
function calculateAmountScore(
  fileAmount: number,
  txAmount: number,
  fileCurrency?: string | null,
  txCurrency?: string | null
): { score: number; source: TransactionMatchSource | null } {
  const absFile = Math.abs(fileAmount);
  const absTx = Math.abs(txAmount);

  // Both must be non-zero
  if (absFile === 0 || absTx === 0) {
    return { score: 0, source: null };
  }

  // Check for currency mismatch
  const normFileCurrency = (fileCurrency || "EUR").toUpperCase();
  const normTxCurrency = (txCurrency || "EUR").toUpperCase();
  const currencyMismatch = normFileCurrency !== normTxCurrency;

  // Calculate base score
  let score = 0;
  let source: TransactionMatchSource | null = null;

  // Exact match
  if (absFile === absTx) {
    score = 40;
    source = "amount_exact";
  } else {
    const difference = Math.abs(absFile - absTx);
    const tolerance = absFile;

    // Within 1%
    if (difference <= tolerance * 0.01) {
      score = 38;
      source = "amount_close";
    }
    // Within 5%
    else if (difference <= tolerance * 0.05) {
      score = 30;
      source = "amount_close";
    }
    // Within 10%
    else if (difference <= tolerance * 0.1) {
      score = 20;
      source = "amount_close";
    }
  }

  // Apply currency mismatch penalty: reduce amount score by 50%
  if (currencyMismatch && score > 0) {
    score = Math.round(score * 0.5);
  }

  return { score, source };
}

/**
 * Calculate date score (0-25)
 * Same day = 25, ≤3 days = 22, ≤7 days = 15, ≤14 days = 8, ≤30 days = 3
 */
function calculateDateScore(
  fileDate: Date,
  txDate: Date
): { score: number; source: TransactionMatchSource | null } {
  const daysDiff = Math.abs(
    Math.floor((fileDate.getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24))
  );

  if (daysDiff === 0) return { score: 25, source: "date_exact" };
  if (daysDiff <= 3) return { score: 22, source: "date_close" };
  if (daysDiff <= 7) return { score: 15, source: "date_close" };
  if (daysDiff <= 14) return { score: 8, source: "date_close" };
  if (daysDiff <= 30) return { score: 3, source: "date_close" };

  return { score: 0, source: null };
}

/**
 * Calculate reference/invoice ID score (0-5)
 * Also returns date bonus if reference matches (bypasses date tolerance)
 */
function calculateReferenceScore(
  extractedText: string,
  reference: string,
  currentDateScore: number
): { score: number; dateBonus: number; source: TransactionMatchSource | null } {
  if (!reference || reference.length < 3) {
    return { score: 0, dateBonus: 0, source: null };
  }

  const normalizedText = extractedText.toLowerCase();
  const normalizedRef = reference.toLowerCase();

  // Check if reference appears in extracted text
  if (normalizedText.includes(normalizedRef)) {
    // Reference match gives +5 score and can add +10 to date score (bypasses date tolerance)
    const dateBonus = currentDateScore < 15 ? 10 : 0;
    return { score: 5, dateBonus, source: "reference" };
  }

  return { score: 0, dateBonus: 0, source: null };
}

// === Batch Matching ===

/**
 * Find matching transactions for a file
 * Returns scored matches sorted by confidence
 *
 * @deprecated Use server callable `findTransactionMatchesForFile` instead.
 */
export function findTransactionMatches(
  file: TaxFile,
  transactions: Transaction[],
  options?: {
    minConfidence?: number;
    limit?: number;
  }
): TransactionMatchScore[] {
  const { minConfidence = TRANSACTION_MATCH_CONFIG.SUGGESTION_THRESHOLD, limit = 10 } =
    options || {};

  // Can't match without extracted data
  if (!file.extractionComplete) {
    return [];
  }

  // Filter to transactions within date range (if file has date)
  let candidates = transactions;
  if (file.extractedDate) {
    const fileDate = file.extractedDate.toDate();
    const startDate = new Date(fileDate);
    startDate.setDate(startDate.getDate() - TRANSACTION_MATCH_CONFIG.DATE_RANGE_DAYS);
    const endDate = new Date(fileDate);
    endDate.setDate(endDate.getDate() + TRANSACTION_MATCH_CONFIG.DATE_RANGE_DAYS);

    candidates = transactions.filter((tx) => {
      const txDate = tx.date.toDate();
      return txDate >= startDate && txDate <= endDate;
    });
  }

  // Score each transaction
  const matches = candidates
    .map((tx) => scoreTransactionMatch(file, tx))
    .filter((m) => m.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  return matches;
}

/**
 * Convert TransactionMatchScore to TransactionSuggestion (for storage)
 *
 * @deprecated Use server callable response conversion instead.
 */
export function toTransactionSuggestion(
  score: TransactionMatchScore
): TransactionSuggestion {
  return {
    transactionId: score.transactionId,
    confidence: score.confidence,
    matchSources: score.matchSources,
    preview: score.preview,
  };
}

// === Partner Priority Resolution ===

export type PartnerMatchedBy = "manual" | "suggestion" | "auto" | null;

/**
 * Resolve partner conflict when both file and transaction have partners
 *
 * Priority:
 * 1. Manual always wins over auto/suggestion
 * 2. If both manual: keep transaction's (user explicitly set on tx)
 * 3. If both auto: file wins (file read the actual document content)
 */
export function resolvePartnerConflict(
  filePartnerId: string | null | undefined,
  fileMatchedBy: PartnerMatchedBy,
  txPartnerId: string | null | undefined,
  txMatchedBy: PartnerMatchedBy
): { winnerId: string | null; source: "file" | "transaction" | null } {
  // Neither has partner
  if (!filePartnerId && !txPartnerId) {
    return { winnerId: null, source: null };
  }

  // Only one has partner - use that one
  if (filePartnerId && !txPartnerId) {
    return { winnerId: filePartnerId, source: "file" };
  }
  if (txPartnerId && !filePartnerId) {
    return { winnerId: txPartnerId, source: "transaction" };
  }

  // Both have partners - apply priority rules

  // Manual always wins over auto/suggestion
  const fileIsManual = fileMatchedBy === "manual";
  const txIsManual = txMatchedBy === "manual";

  if (fileIsManual && !txIsManual) {
    return { winnerId: filePartnerId!, source: "file" };
  }
  if (txIsManual && !fileIsManual) {
    return { winnerId: txPartnerId!, source: "transaction" };
  }

  // Both manual - keep transaction's (user explicitly set on tx)
  if (fileIsManual && txIsManual) {
    return { winnerId: txPartnerId!, source: "transaction" };
  }

  // Both auto/suggestion - file wins (it read the document)
  return { winnerId: filePartnerId!, source: "file" };
}

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
