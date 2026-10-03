import { Timestamp } from "firebase/firestore";
import { ChangeAuthor } from "./transaction-history";

/**
 * Search strategy identifiers (executed in order)
 */
export type SearchStrategy =
  | "partner_files" // Strategy 1: Files from known partner
  | "amount_files" // Strategy 2: Amount-based file search
  | "email_attachment" // Strategy 3: Gmail attachment search
  | "email_invoice"; // Strategy 4: Email body invoice parsing

/**
 * What triggered the precision search
 */
export type PrecisionSearchTrigger = "gmail_sync" | "manual" | "scheduled";

/**
 * Status of a search operation
 */
export type PrecisionSearchStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/**
 * Parameters used for a search attempt
 */
export interface SearchParams {
  /** Gmail search query (for email strategies) */
  query?: string;

  /** Partner ID being searched (for partner_files strategy) */
  partnerId?: string;

  /** Amount range searched (in cents) */
  amountRange?: {
    min: number;
    max: number;
  };

  /** Date range searched */
  dateRange?: {
    from: Timestamp;
    to: Timestamp;
  };

  /** Integration IDs used (for email strategies) */
  integrationIds?: string[];
}

/**
 * Result of a single search attempt (one strategy execution)
 */
export interface SearchAttempt {
  /** Which strategy was executed */
  strategy: SearchStrategy;

  /** When this attempt started */
  startedAt: Timestamp;

  /** When this attempt completed */
  completedAt?: Timestamp;

  /** Parameters used for this search */
  searchParams: SearchParams;

  // === Results ===

  /** Number of candidates found (files, emails, etc.) */
  candidatesFound: number;

  /** Number of candidates evaluated with AI */
  candidatesEvaluated: number;

  /** Number of matches found above threshold */
  matchesFound: number;

  /** File IDs that were connected to the transaction */
  fileIdsConnected: string[];

  /**
   * Stored Files a local-file strategy nominated the transaction to (#589):
   * the matcher scored the pair and decided. Connected ones are also in
   * `fileIdsConnected`.
   */
  fileIdsNominated?: string[];

  /** Invoice links discovered (for email_invoice strategy) */
  invoiceLinksFound?: string[];

  // === AI Usage ===

  /** Number of Gemini API calls made */
  geminiCalls?: number;

  /** Total tokens used (input + output) */
  geminiTokensUsed?: number;

  // === Error Handling ===

  /** Error message if this attempt failed */
  error?: string;
}

/**
 * A transaction search log entry.
 * Stored in: transactions/{id}/searches/{searchId}
 *
 * Records all search attempts for a transaction, including which strategies
 * were tried and what was found. Used for debugging and audit trail.
 */
export interface TransactionSearchEntry {
  id: string;

  // === Trigger Info ===

  /** What triggered this search */
  triggeredBy: PrecisionSearchTrigger;

  /** Who/what initiated the search (for traceability) */
  triggeredByAuthor?: ChangeAuthor;

  /** Gmail sync queue ID (if triggered by gmail_sync) */
  gmailSyncQueueId?: string;

  /** Precision search queue ID (if part of batch processing) */
  precisionSearchQueueId?: string;

  // === Status ===

  /** Current status of this search */
  status: PrecisionSearchStatus;

  // === Strategies ===

  /** Which strategies were attempted */
  strategiesAttempted: SearchStrategy[];

  /** Detailed results for each attempt */
  attempts: SearchAttempt[];

  // === Final Outcome ===

  /** Total files connected across all strategies */
  totalFilesConnected: number;

  /** Which strategy ultimately matched (if any) */
  automationSource?: SearchStrategy;

  // === AI Usage Aggregated ===

  /** Total Gemini calls across all attempts */
  totalGeminiCalls: number;

  /** Total tokens used across all attempts */
  totalGeminiTokens: number;

  // === Timestamps ===

  /** When this search entry was created */
  createdAt: Timestamp;

  /** When processing started */
  startedAt?: Timestamp;

  /** When processing completed (success or failure) */
  completedAt?: Timestamp;
}

/**
 * Queue item for precision search processing.
 * Collection: /precisionSearchQueue/{id}
 *
 * Follows the same pattern as GmailSyncQueueItem for consistency.
 * Enables batch processing, progress tracking, and resumption.
 */
export interface PrecisionSearchQueueItem {
  id: string;

  /** User who owns this search */
  userId: string;

  // === Scope ===

  /** Whether to process all incomplete transactions or just one */
  scope: "all_incomplete" | "single_transaction";

  /** Transaction ID (only for single_transaction scope) */
  transactionId?: string;

  // === Trigger Info ===

  /** What triggered this search */
  triggeredBy: PrecisionSearchTrigger;

  /** Who/what initiated the search */
  triggeredByAuthor?: ChangeAuthor;

  /** Gmail sync queue ID (if triggered by gmail_sync) */
  gmailSyncQueueId?: string;

  // === Processing State ===

  /** Current status */
  status: PrecisionSearchStatus;

  // === Progress Tracking ===

  /** Total transactions to process */
  transactionsToProcess: number;

  /** Transactions processed so far */
  transactionsProcessed: number;

  /** Transactions that got at least one match */
  transactionsWithMatches: number;

  /** Total files connected across all transactions */
  totalFilesConnected: number;

  // === Resumption ===

  /** Last processed transaction ID (for cursor-based pagination) */
  lastProcessedTransactionId?: string;

  // === Strategy State ===

  /** Strategies to run (in order) */
  strategies: SearchStrategy[];

  /** Current strategy index (for resumption) */
  currentStrategyIndex: number;

  // === Error Handling ===

  /** Error messages encountered */
  errors: string[];

  /** Number of retry attempts */
  retryCount: number;

  /** Maximum retries before failing */
  maxRetries: number;

  /** Last error message */
  lastError?: string;

  // === Timestamps ===

  /** When queue item was created */
  createdAt: Timestamp;

  /** When processing started */
  startedAt?: Timestamp;

  /** When processing completed */
  completedAt?: Timestamp;
}

/**
 * Invoice link discovered in an email body (for Strategy 4).
 * Stored on partner for manual download later.
 */
export interface DiscoveredInvoiceLink {
  /** The URL to the invoice */
  url: string;

  /** Anchor text if available (e.g., "Download Invoice") */
  anchorText?: string;

  /** When this link was discovered */
  discoveredAt: Timestamp;

  /** Gmail message ID where this link was found */
  emailMessageId: string;

  /** Email subject for context */
  emailSubject?: string;

  /** Email sender address */
  emailFrom?: string;

  /** Whether user has verified/downloaded this invoice */
  verified: boolean;

  /** Transaction ID this link is associated with (if any) */
  transactionId?: string;
}

/**
 * Input for batch matching transactions to files with Gemini.
 * Used by Strategy 1 (partner_files) for many-to-many matching.
 */
export interface BatchMatchRequest {
  transactions: Array<{
    id: string;
    amount: number; // in cents
    date: string; // ISO date string
    partner?: string;
    name?: string;
  }>;
  files: Array<{
    id: string;
    extractedAmount?: number; // in cents
    extractedDate?: string; // ISO date string
    extractedPartner?: string;
    fileName: string;
  }>;
}

/**
 * Response from Gemini batch matching.
 */
export interface BatchMatchResponse {
  matches: Array<{
    transactionId: string;
    fileId: string;
    confidence: number; // 0-100
    reasoning: string;
  }>;
  /** Any transactions that couldn't be matched */
  unmatched?: Array<{
    transactionId: string;
    reason: string;
  }>;
}

/**
 * Context passed to strategy execution functions
 */
export interface StrategyContext {
  /** User ID */
  userId: string;

  /** Firestore reference */
  db: unknown;

  /** Queue item ID (for logging) */
  queueId: string;

  /** Transaction search entry ID (for logging) */
  searchEntryId: string;

  /** Email integrations available for this user */
  emailIntegrations?: Array<{
    id: string;
    email: string;
    provider: string;
  }>;

  /** Abort signal for timeout handling */
  abortSignal?: AbortSignal;
}

/**
 * Result from a strategy execution
 */
export interface StrategyResult {
  /** The search attempt record */
  attempt: SearchAttempt;

  /** Whether any files were connected */
  hasMatches: boolean;

  /** Whether to continue with next strategy */
  continueToNextStrategy: boolean;
}

/**
 * Data for creating a precision search queue item
 */
export interface CreatePrecisionSearchData {
  userId: string;
  scope: "all_incomplete" | "single_transaction";
  transactionId?: string;
  triggeredBy: PrecisionSearchTrigger;
  triggeredByAuthor?: ChangeAuthor;
  gmailSyncQueueId?: string;
  strategies?: SearchStrategy[];
}

/**
 * Summary of precision search results for UI display
 */
export interface PrecisionSearchSummary {
  /** Queue item ID */
  queueId: string;

  /** Current status */
  status: PrecisionSearchStatus;

  /** Progress percentage (0-100) */
  progress: number;

  /** Transactions processed / total */
  transactionsProcessed: number;
  transactionsToProcess: number;

  /** Results */
  transactionsWithMatches: number;
  totalFilesConnected: number;

  /** Duration in seconds (if completed) */
  durationSeconds?: number;

  /** Error message if failed */
  error?: string;
}
