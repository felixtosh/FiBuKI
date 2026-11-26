import type { Timestamp } from "firebase/firestore";

/**
 * Card Reconciliation Types
 *
 * Handles detection and reconciliation of credit card payments that appear
 * as both card charges and bank debits (statement payments, pass-throughs).
 */

/** How the bank payment relates to the card charges */
export type ReconciliationPattern =
  | "statement_payment"   // Lump-sum bank debit covering multiple card charges
  | "pass_through"        // Individual card charge passed through as bank debit
  | "partial_payment";    // Bank payment covers only some of the card charges

/** Lifecycle status of a reconciliation group */
export type ReconciliationGroupStatus = "suggested" | "confirmed" | "rejected";

/**
 * Breakdown of how the reconciliation confidence score was calculated.
 * Total possible: 100 points.
 */
export interface ReconciliationScoreBreakdown {
  /** 0-40: How well the card charges sum matches the bank payment amount */
  amountSum: number;
  /** 0-25: Whether card charges fall within expected billing window */
  dateWindow: number;
  /** 0-20: Whether card.linkedSourceId matches the bank transaction's source */
  sourceLink: number;
  /** 0-15: Bank tx's partner is a source partner or has internal-transfers category */
  partnerSignal: number;
}

/**
 * A group linking a bank payment to one or more card charges it pays for.
 * Stored in `cardReconciliationGroups/{id}` collection.
 */
export interface CardReconciliationGroup {
  id: string;
  userId: string;

  /** The bank transaction that represents the payment */
  bankTransactionId: string;
  /** Source ID of the bank account */
  bankSourceId: string;

  /** Source ID of the credit card */
  cardSourceId: string;
  /** Card transaction IDs included in this group */
  cardTransactionIds: string[];

  /** Sum of absolute card charge amounts (cents) */
  cardChargesSum: number;
  /** Absolute bank payment amount (cents) */
  bankPaymentAmount: number;
  /** Difference between bank payment and card charges sum (cents, can be negative) */
  remainderAmount: number;

  /** Detected pattern type */
  pattern: ReconciliationPattern;
  /** Lifecycle status */
  status: ReconciliationGroupStatus;

  /** Overall confidence score (0-100) */
  confidence: number;
  /** Detailed score breakdown */
  scoreBreakdown: ReconciliationScoreBreakdown;

  /** Date range of the card charges in this group */
  cardChargesDateRange: { from: Timestamp; to: Timestamp };

  /** Card transaction IDs the user removed from the group during review */
  rejectedCardTransactionIds?: string[];
  /** Optional user note (e.g., explaining remainder as FX fees) */
  note?: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Denormalized suggestion stored on bank transactions for quick UI display.
 * Full group details are in `cardReconciliationGroups/{groupId}`.
 */
export interface ReconciliationSuggestion {
  groupId: string;
  cardSourceName: string;
  chargeCount: number;
  chargesSum: number;
  confidence: number;
  pattern: ReconciliationPattern;
  remainderAmount: number;
}
