import { Timestamp } from "firebase/firestore";

/**
 * How a transaction is documented (#104).
 *
 * Duplicated from `functions/src/documents/types.ts` the same way
 * `DocumentType` is in `types/file.ts`: `functions/tsconfig.json` pins
 * `rootDir: "src"`, so the two trees cannot share a file. The backend module
 * is the source of truth for the DERIVATION; this is the shape the UI reads.
 */
export type DocumentationState =
  | "invoice"
  | "receipt-only"
  | "no-receipt-category"
  | "undocumented"
  | "unknown";

/**
 * Entry in the automation history for a transaction.
 * Tracks what automated actions were performed and when.
 */
export interface AutomationHistoryEntry {
  /** Type of automation that ran */
  type:
    | "file_matching"
    | "partner_matching"
    | "company_check"
    | "receipt_search"
    | "partner_assigned"
    | "partner_removed"
    | "category_assigned"
    | "category_removed"
    | "file_connected"
    | "file_disconnected"
    | "category_matched";
  /** When it ran */
  ranAt: Timestamp;
  /** Status of the run */
  status: "completed" | "failed" | "no_match" | "pending" | "skipped";
  /** Who/what triggered this action */
  actor?: "auto" | "manual" | "ai" | "suggestion";
  /** Brief summary of what happened */
  summary?: string;
  /** Partner ID at time of run (to detect if partner changed) */
  forPartnerId?: string | null;
  /** Partner name for display */
  partnerName?: string;
  /** File ID involved */
  fileId?: string;
  /** File name for display */
  fileName?: string;
  /** Category name for display */
  categoryName?: string;
  /** Match confidence (0-100) */
  confidence?: number;
  /** Worker run ID for linking to full transcript */
  workerRunId?: string;
  /** Activity level for filtering and analysis */
  level?: "decision" | "outcome" | "info";
}

/**
 * A financial transaction imported from a bank account.
 * All transactions must be associated with a source (bank account).
 */
export interface Transaction {
  id: string;

  /** Required - links to the source/bank account */
  sourceId: string;

  // === Normalized/processed fields (primary) ===

  /** Transaction date as Firebase Timestamp */
  date: Timestamp;

  /** Amount in cents, with normalized sign (negative = expense) */
  amount: number;

  /** Currency code, e.g., "EUR" */
  currency: string;

  // === Original values (backup) ===

  /** Original values before parsing/normalization */
  _original: {
    /** Original date string, e.g., "15.03.2024" */
    date: string;
    /** Original amount string, e.g., "-1.234,56" */
    amount: string;
    /** All CSV columns preserved as key-value pairs */
    rawRow: Record<string, string>;
  };

  // === Core fields ===

  /** Transaction description/booking text */
  name: string;

  /** User-added description for tax purposes */
  description: string | null;

  /** Counterparty name (sender/receiver) */
  partner: string | null;

  /** Bank reference number or transaction ID */
  reference: string | null;

  /** Counterparty IBAN if available */
  partnerIban: string | null;

  // === Deduplication ===

  /** SHA256 hash for deduplication: hash(date + amount + iban + reference) */
  dedupeHash: string;

  // === Classification ===

  /** Array of connected file IDs (many-to-many relationship). Optional for backward compatibility. */
  fileIds?: string[];

  /**
   * Array of file IDs that were manually rejected/removed by the user.
   * @deprecated Use rejectedFiles instead (which includes timestamps)
   */
  rejectedFileIds?: string[];

  /**
   * Array of rejected file records with timestamps and context.
   * Prevents automation from re-connecting these files to this transaction.
   * New format — code should handle both rejectedFileIds (legacy) and rejectedFiles.
   */
  rejectedFiles?: Array<{
    fileId: string;
    rejectedAt: Timestamp;
    /** Confidence of the match that was rejected */
    matchConfidence?: number | null;
  }>;

  /**
   * Which automation strategy connected the most recent file to this transaction.
   * Used for tracking and debugging precision search results.
   * Set by precision search when files are auto-connected.
   */
  fileAutomationSource?: import("./precision-search").SearchStrategy | null;

  /** Whether transaction has documentation (file OR no-receipt category) */
  isComplete: boolean;

  /**
   * WHAT the documentation is (#104). Additive to `isComplete`, which keeps
   * its meaning of "has some documentation" — a line that is green today does
   * not turn red because this field exists.
   *
   * `receipt-only` is the bookkeeping gap: the transaction holds a payment
   * confirmation, no invoice satisfying § 11 was ever received, and no
   * Vorsteuer may be claimed on it. Absent on every row written before #104,
   * which is "never checked", not "checked and fine".
   *
   * Derived in the onTransactionUpdate trigger from the attached files'
   * `documentType`, never authored.
   */
  documentationState?: DocumentationState;

  // === Metadata ===

  /** ID of the import job that created this transaction */
  importJobId: string | null;

  /**
   * Row index in the original CSV (0-indexed, excluding header).
   * Used to preserve manual edits when re-mapping CSV imports.
   * Only present for CSV imports, not API syncs.
   */
  csvRowIndex?: number;

  /** Owner of this transaction */
  userId: string;

  // === Partner Matching ===
  // Note: These use `| null` (not just `?`) so Firestore queries work.
  // Firestore `where("partnerId", "==", null)` only matches explicit null, not missing fields.

  /** Linked partner ID (if matched) */
  partnerId?: string | null;

  /** Whether linked partner is global or user-specific */
  partnerType?: "global" | "user" | null;

  /** Match confidence (0-100) */
  partnerMatchConfidence?: number | null;

  /** How the partner was matched: auto (≥95%), manual, ai (chat agent), or suggestion click */
  partnerMatchedBy?: "auto" | "manual" | "ai" | "suggestion" | null;

  /** Top 3 partner suggestions (stored for UI display) */
  partnerSuggestions?: Array<{
    partnerId: string;
    partnerType: "global" | "user";
    confidence: number;
    source: "iban" | "vatId" | "website" | "name";
  }>;

  // === No-Receipt Category ===
  // Note: These use `| null` (not just `?`) so Firestore queries work.

  /** No-receipt category ID (if assigned instead of file) */
  noReceiptCategoryId?: string | null;

  /** Template ID for quick identification */
  noReceiptCategoryTemplateId?: import("./no-receipt-category").NoReceiptCategoryId | null;

  /** How the category was assigned */
  noReceiptCategoryMatchedBy?: "manual" | "suggestion" | "auto" | null;

  /** Category match confidence (0-100) */
  noReceiptCategoryConfidence?: number | null;

  /** Top category suggestions (stored for UI display) */
  categorySuggestions?: import("./no-receipt-category").CategorySuggestion[];

  /** Receipt lost entry (only for "receipt-lost" category) */
  receiptLostEntry?: import("./no-receipt-category").ReceiptLostEntry | null;

  // === Automation History ===

  /**
   * History of automated actions run on this transaction.
   * Prevents re-running the same automation and tracks what was done.
   */
  automationHistory?: AutomationHistoryEntry[];

  // === AI Search Queries (cached) ===

  /** @deprecated Use searchSuggestions instead */
  aiSearchQueries?: string[] | null;

  /** @deprecated Use searchSuggestions instead */
  aiSearchQueriesForPartnerId?: string | null;

  /** Cached search suggestions for finding receipts (generated by Gemini) */
  searchSuggestions?: {
    /** Typed suggestions with query, type, and score */
    suggestions: Array<{
      query: string;
      type: "invoice_number" | "company_name" | "email_domain" | "vat_id" | "iban" | "pattern" | "fallback";
      score: number;
    }>;
    /** When suggestions were generated */
    generatedAt: Timestamp;
    /** Partner ID at time of generation (for invalidation check) */
    partnerId?: string | null;
    /** Hash of partner data used (emailDomains, aliases, fileSourcePatterns) */
    partnerDataHash?: string;
  };

  // === Tax/VAT Information (for reporting) ===

  /** VAT rate applied to this transaction (0, 10, 13, 20 for Austria) */
  vatRate?: number | null;

  /** VAT amount in cents (extracted from invoice or calculated) */
  vatAmount?: number | null;

  /** Whether this is an EU cross-border transaction (affects VAT treatment) */
  isEuTransaction?: boolean | null;

  /** Whether reverse charge applies (B2B EU services) */
  isReverseCharge?: boolean | null;

  /** Whether this transaction exceeds the plan's monthly quota (imported but limited) */
  quotaExceeded?: boolean;

  // === Card Reconciliation ===

  /** Bank transactions: pending reconciliation suggestions from card matching */
  reconciliationSuggestions?: import("./card-reconciliation").ReconciliationSuggestion[];

  /** Bank transactions: whether the reconciliation trigger has processed this tx */
  reconciliationMatchComplete?: boolean;

  /** Card transactions: bank transaction ID that pays for this charge */
  reconciledByBankTxId?: string | null;

  /** Card transactions: reconciliation group membership */
  reconciliationGroupId?: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Derive the activity level from an automation history entry's type and actor.
 * Used for backward compatibility with entries that don't have `level` set,
 * and as the single source of truth for level classification.
 */
export function deriveActivityLevel(
  entry: Pick<AutomationHistoryEntry, "type" | "actor" | "level">
): "decision" | "outcome" | "info" {
  // Use persisted level if available
  if (entry.level) return entry.level;

  const { type, actor } = entry;

  // Process telemetry types are always info
  if (
    type === "receipt_search" ||
    type === "file_matching" ||
    type === "partner_matching" ||
    type === "company_check"
  ) {
    return "info";
  }

  // category_matched is always an automation outcome
  if (type === "category_matched") {
    return "outcome";
  }

  // Removal types are always user decisions
  if (type === "partner_removed" || type === "file_disconnected" || type === "category_removed") {
    return "decision";
  }

  // Assignment types: decision if manual/suggestion, outcome if auto/ai
  if (actor === "auto" || actor === "ai") {
    return "outcome";
  }

  return "decision";
}

/**
 * Filters for querying transactions
 */
export interface TransactionFilters {
  /** Text search in name, description, partner */
  search?: string;

  /** Filter by source/bank account */
  sourceId?: string;

  /** Date range start */
  dateFrom?: Date;

  /** Date range end */
  dateTo?: Date;

  /** Filter by file attachment status */
  hasFile?: boolean;

  /** Filter by completion status */
  isComplete?: boolean;

  /** Filter by import job ID */
  importId?: string;

  /** Amount type: positive (income), negative (expense), or all */
  amountType?: "income" | "expense" | "all";

  /** Filter by matched partner ID */
  partnerId?: string;

  /** Filter by multiple partner IDs */
  partnerIds?: string[];

  /** Filter by partner match status */
  hasPartner?: boolean;
}

export type TransactionSortField = "date" | "name" | "amount" | "partner";
export type SortDirection = "asc" | "desc";
