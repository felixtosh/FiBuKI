/**
 * Reconciliation Scoring Module
 *
 * Scores how likely a bank transaction is a credit card statement payment
 * by comparing it against card charges from the linked card source.
 *
 * Score breakdown (max 100):
 * - amountSum            (0-40): card charges sum vs bank payment amount
 * - dateWindow           (0-25): charges within expected billing window before payment
 * - sourceLink           (0-20): card.linkedSourceId matches bank tx source
 * - partnerSignal       (0-15): bank tx's partner is a source partner or has internal-transfers
 *
 * Reconciliation is triggered by onTransactionUpdate when a source partner is assigned.
 * The source partner system (sourcePartnerUtils.ts) handles alias generation for card brands.
 */

import { Timestamp } from "firebase-admin/firestore";
import {
  ReconciliationScoreBreakdown,
  ReconciliationPattern,
} from "../types/card-reconciliation";

// === Configuration ===

export const RECONCILIATION_CONFIG = {
  /** Minimum confidence for auto-confirmation */
  AUTO_CONFIRM_THRESHOLD: 85,
  /** Minimum confidence to show as suggestion */
  SUGGESTION_THRESHOLD: 50,
  /** Days before bank payment to look for card charges */
  LOOKBACK_DAYS: 45,
};

// === Types ===

export interface CardChargeData {
  id: string;
  amount: number; // cents, negative for charges
  date: Timestamp;
  name: string;
}

export interface BankPaymentCandidate {
  id: string;
  amount: number; // cents, negative = outgoing payment
  date: Timestamp;
  name: string;
  sourceId: string;
  /** Existing no-receipt category assignment (from category matching system) */
  noReceiptCategoryTemplateId?: string | null;
  /** Existing partner ID assignment (from partner matching system) */
  partnerId?: string | null;
}

export interface ReconciliationMatch {
  bankTransaction: BankPaymentCandidate;
  cardTransactions: CardChargeData[];
  cardChargesSum: number;
  bankPaymentAmount: number;
  remainderAmount: number;
  confidence: number;
  scoreBreakdown: ReconciliationScoreBreakdown;
  pattern: ReconciliationPattern;
}

// === Scoring Functions ===

/**
 * Score how well the card charges sum matches the bank payment amount.
 * Max 40 points.
 */
export function calculateAmountSumScore(
  chargesSum: number,
  bankPayment: number
): number {
  if (chargesSum === 0 || bankPayment === 0) return 0;

  const absCharges = Math.abs(chargesSum);
  const absPayment = Math.abs(bankPayment);

  if (absCharges === absPayment) return 40;

  const diff = Math.abs(absCharges - absPayment);
  const ratio = diff / absPayment;

  if (ratio <= 0.005) return 35; // within 0.5%
  if (ratio <= 0.02) return 25;  // within 2%
  if (ratio <= 0.05) return 15;  // within 5%
  if (ratio <= 0.10) return 5;   // within 10%

  return 0;
}

/**
 * Score whether card charges fall within a reasonable billing window
 * before the bank payment date.
 * Max 25 points.
 */
export function calculateDateWindowScore(
  charges: CardChargeData[],
  bankPaymentDate: Date,
  lookbackDays: number = RECONCILIATION_CONFIG.LOOKBACK_DAYS
): number {
  if (charges.length === 0) return 0;

  const paymentMs = bankPaymentDate.getTime();
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  const windowStart = paymentMs - lookbackMs;

  let withinWindow = 0;
  for (const charge of charges) {
    const chargeMs = charge.date.toDate().getTime();
    if (chargeMs >= windowStart && chargeMs <= paymentMs) {
      withinWindow++;
    }
  }

  const ratio = withinWindow / charges.length;

  if (ratio === 1) return 25;       // all charges in window
  if (ratio >= 0.9) return 20;
  if (ratio >= 0.7) return 15;
  if (ratio >= 0.5) return 10;

  return 0;
}

/**
 * Score whether the card source is linked to the bank source.
 * Max 20 points.
 */
export function calculateSourceLinkScore(
  cardLinkedSourceId: string | undefined,
  bankSourceId: string
): number {
  if (!cardLinkedSourceId) return 0;
  return cardLinkedSourceId === bankSourceId ? 20 : 0;
}

/**
 * Score whether the bank transaction is recognized as a card payment
 * by the partner and category systems.
 * Max 15 points.
 *
 * Simplified: reconciliation is only triggered when a source partner is
 * assigned to the bank tx (via onTransactionUpdate), so if isSourcePartner
 * is true we give full points. Falls back to internal-transfers category.
 */
export function calculateCategoryPartnerSignalScore(
  bankTx: BankPaymentCandidate,
  isSourcePartner: boolean
): number {
  // Bank tx's partner is a source partner → full points (this is the trigger)
  if (isSourcePartner) {
    return 15;
  }

  // Fallback: existing category assignment from category matching system
  if (bankTx.noReceiptCategoryTemplateId === "internal-transfers") {
    return 10;
  }

  return 0;
}

/**
 * Determine the reconciliation pattern based on charge count and remainder.
 */
export function detectPattern(
  chargeCount: number,
  remainderAmount: number,
  bankPaymentAmount: number
): ReconciliationPattern {
  if (chargeCount === 1) {
    return "pass_through";
  }

  const remainderRatio = Math.abs(remainderAmount) / Math.abs(bankPaymentAmount);
  if (remainderRatio > 0.1) {
    return "partial_payment";
  }

  return "statement_payment";
}

// === Best-Fit Subset Matching ===

/**
 * Find the best subset of card charges whose sum is closest to the target amount.
 * Uses a greedy approach for efficiency — good enough for reconciliation since
 * we're usually looking for "all charges" or "all minus a few".
 *
 * Tries three strategies:
 * 1. All charges (most common for statement payments)
 * 2. Greedy accumulation (sort by amount desc, add until sum >= target)
 * 3. Leave-one-out (remove charges one-by-one to find best fit)
 */
export function findBestSubset(
  charges: CardChargeData[],
  targetAmount: number
): { subset: CardChargeData[]; sum: number } {
  const absTarget = Math.abs(targetAmount);

  // Strategy 1: All charges
  const allSum = charges.reduce((s, c) => s + Math.abs(c.amount), 0);
  let bestSubset = charges;
  let bestSum = allSum;
  let bestDiff = Math.abs(allSum - absTarget);

  // If all charges is exact or very close, use it
  if (bestDiff / absTarget <= 0.005) {
    return { subset: bestSubset, sum: bestSum };
  }

  // Strategy 2: Greedy accumulation (sort desc, add until >= target)
  const sorted = [...charges].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount)
  );

  let greedySubset: CardChargeData[] = [];
  let greedySum = 0;
  for (const charge of sorted) {
    greedySubset.push(charge);
    greedySum += Math.abs(charge.amount);
    if (greedySum >= absTarget) break;
  }

  const greedyDiff = Math.abs(greedySum - absTarget);
  if (greedyDiff < bestDiff) {
    bestSubset = greedySubset;
    bestSum = greedySum;
    bestDiff = greedyDiff;
  }

  // Strategy 3: Leave-one-out (only if we have <= 50 charges to keep it fast)
  if (charges.length <= 50 && allSum > absTarget) {
    for (let i = 0; i < charges.length; i++) {
      const subsetSum = allSum - Math.abs(charges[i].amount);
      const diff = Math.abs(subsetSum - absTarget);
      if (diff < bestDiff) {
        bestSubset = charges.filter((_, idx) => idx !== i);
        bestSum = subsetSum;
        bestDiff = diff;
      }
    }
  }

  return { subset: bestSubset, sum: bestSum };
}

// === Main Scoring Function ===

/**
 * Score a bank payment against a set of card charges.
 * Returns a full reconciliation match with confidence score.
 *
 * @param isSourcePartner - Whether the bank tx's partner is a source partner
 *   (i.e., the trigger that initiated reconciliation).
 */
export function scoreReconciliation(
  bankTx: BankPaymentCandidate,
  allCardCharges: CardChargeData[],
  cardLinkedSourceId: string | undefined,
  isSourcePartner: boolean = true
): ReconciliationMatch | null {
  if (allCardCharges.length === 0) return null;

  const absBankPayment = Math.abs(bankTx.amount);

  // Find best-fitting subset of charges
  const { subset, sum: chargesSum } = findBestSubset(allCardCharges, bankTx.amount);

  if (subset.length === 0) return null;

  const remainderAmount = absBankPayment - chargesSum;

  // Calculate score components
  const amountSum = calculateAmountSumScore(chargesSum, bankTx.amount);
  const dateWindow = calculateDateWindowScore(subset, bankTx.date.toDate());
  const sourceLink = calculateSourceLinkScore(cardLinkedSourceId, bankTx.sourceId);
  const partnerSignal = calculateCategoryPartnerSignalScore(bankTx, isSourcePartner);

  const confidence = Math.min(100, amountSum + dateWindow + sourceLink + partnerSignal);

  const scoreBreakdown: ReconciliationScoreBreakdown = {
    amountSum,
    dateWindow,
    sourceLink,
    partnerSignal,
  };

  const pattern = detectPattern(subset.length, remainderAmount, absBankPayment);

  return {
    bankTransaction: bankTx,
    cardTransactions: subset,
    cardChargesSum: chargesSum,
    bankPaymentAmount: absBankPayment,
    remainderAmount,
    confidence,
    scoreBreakdown,
    pattern,
  };
}

/**
 * Format a reconciliation score breakdown for logging.
 */
export function formatReconciliationBreakdown(
  breakdown: ReconciliationScoreBreakdown
): string {
  const parts: string[] = [];
  if (breakdown.amountSum > 0) parts.push(`amt:${breakdown.amountSum}`);
  if (breakdown.dateWindow > 0) parts.push(`date:${breakdown.dateWindow}`);
  if (breakdown.sourceLink > 0) parts.push(`src:${breakdown.sourceLink}`);
  if (breakdown.partnerSignal > 0) parts.push(`partner:${breakdown.partnerSignal}`);
  return parts.join(" + ");
}
