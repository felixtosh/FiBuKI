import { Timestamp } from "firebase/firestore";

/**
 * Category template IDs (hardcoded)
 */
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

/**
 * How the UVA calculation treats transactions in this category (fork #64):
 * - exempt-class: zero input VAT by law (bank fees, payroll, taxes) — R9
 * - documented-elsewhere: outside the report's scope (transfers, private)
 * - needs-receipt: stays on the receipt-chasing worklist (Eigenbeleg
 *   never creates a VAT deduction)
 */
export type CategoryVatTreatment =
  | "exempt-class"
  | "documented-elsewhere"
  | "needs-receipt";

/**
 * Template definition for no-receipt categories (hardcoded)
 */
export interface NoReceiptCategoryTemplate {
  id: NoReceiptCategoryId;
  name: string;
  description: string;
  helperText: string;
  /** Whether this category requires additional confirmation/info (e.g., receipt-lost) */
  requiresConfirmation?: boolean;
  /** UVA treatment; copied onto user categories at initialization */
  vatTreatment?: CategoryVatTreatment;
}

/**
 * Learned pattern for category matching (similar to partner patterns)
 */
export interface CategoryLearnedPattern {
  /** Glob-style pattern (e.g., "*stripe*payout*") */
  pattern: string;
  /** Confidence score (0-100) */
  confidence: number;
  /** When this pattern was learned */
  createdAt: Timestamp;
  /** Transaction IDs that contributed to learning this pattern */
  sourceTransactionIds: string[];
}

/**
 * Record of a transaction that was manually removed from this category.
 * Used as negative training signal (false positive) for pattern learning.
 */
export interface CategoryManualRemoval {
  /** ID of the transaction that was removed */
  transactionId: string;
  /** When the removal happened */
  removedAt: Timestamp;
  /** Snapshot of transaction's partner field (for pattern learning) */
  partner: string | null;
  /** Snapshot of transaction's name field (for pattern learning) */
  name: string;
}

/**
 * User-specific no-receipt category instance
 * Collection: /noReceiptCategories/{id}
 */
export interface UserNoReceiptCategory {
  id: string;

  /** Owner of this category */
  userId: string;

  /** Reference to template ID */
  templateId: NoReceiptCategoryId;

  /** Display name (from template, can be customized) */
  name: string;

  /** Description (from template) */
  description: string;

  /** Helper text for UI */
  helperText: string;

  /** Partner IDs that are matched to this category */
  matchedPartnerIds: string[];

  /** AI-learned patterns for matching transactions */
  learnedPatterns: CategoryLearnedPattern[];

  /** When patterns were last updated */
  patternsUpdatedAt?: Timestamp;

  /**
   * Transactions user explicitly removed from this category.
   * Used as negative training signal (false positives) for pattern learning.
   * Capped at 50 entries.
   */
  manualRemovals?: CategoryManualRemoval[];

  /** UVA treatment (from template, can be customized) — fork #64 */
  vatTreatment?: CategoryVatTreatment;

  /** Transaction count using this category */
  transactionCount: number;

  /** Active status */
  isActive: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Receipt lost entry (self-generated receipt / Eigenbeleg)
 * Stored directly on transaction as embedded object
 */
export interface ReceiptLostEntry {
  /** User-provided reason */
  reason: string;
  /** User-provided description */
  description: string;
  /** When this was created */
  createdAt: Timestamp;
  /** Confirmed by user */
  confirmed: boolean;
}

/**
 * Category suggestion for a transaction
 */
export interface CategorySuggestion {
  categoryId: string;
  templateId: NoReceiptCategoryId;
  confidence: number;
  source: "partner" | "pattern" | "partner+pattern";
}

