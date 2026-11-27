import type { Timestamp } from "firebase/firestore";

/**
 * Type of Gmail sync
 */
export type GmailSyncType = "initial" | "scheduled" | "manual";

/**
 * Status of a sync queue item
 */
export type GmailSyncStatus = "pending" | "processing" | "completed" | "failed" | "paused";

/**
 * Queue item for Gmail sync processing.
 * Collection: /gmailSyncQueue/{id}
 *
 * The queue system enables:
 * - Rate limiting for Gmail API (5 req/sec)
 * - Pagination handling for large email sets
 * - Retry logic for transient failures
 * - Progress tracking for UI feedback
 */
export interface GmailSyncQueueItem {
  id: string;

  /** User who owns this sync */
  userId: string;

  /** Email integration (Gmail account) to sync */
  integrationId: string;

  /** Type of sync operation */
  type: GmailSyncType;

  /** Current processing status */
  status: GmailSyncStatus;

  // === Date Range ===

  /** Start date for email search (inclusive) */
  dateFrom: Timestamp;

  /** End date for email search (inclusive) */
  dateTo: Timestamp;

  // === Pagination State ===

  /** Gmail API page token for resuming */
  nextPageToken?: string;

  /** Current page number (for progress display) */
  currentPage?: number;

  // === Progress Tracking ===

  /** Number of emails processed so far */
  emailsProcessed: number;

  /** Number of files created so far */
  filesCreated: number;

  /** Number of attachments skipped (duplicates, non-invoices) */
  attachmentsSkipped: number;

  /** Error messages encountered during processing */
  errors: string[];

  // === Retry Handling ===

  /** Number of retry attempts */
  retryCount: number;

  /** Maximum retries before failing */
  maxRetries: number;

  /** Last error message (for retry decision) */
  lastError?: string;

  // === Timestamps ===

  /** When queue item was created */
  createdAt: Timestamp;

  /** When processing started */
  startedAt?: Timestamp;

  /** When processing completed (success or failure) */
  completedAt?: Timestamp;
}

/**
 * Result of a completed sync operation
 */
export interface GmailSyncResult {
  /** Whether sync was fully successful */
  success: boolean;

  /** Number of emails searched */
  emailsSearched: number;

  /** Number of files created */
  filesCreated: number;

  /** Number of attachments skipped */
  attachmentsSkipped: number;

  /** Error message if failed */
  error?: string;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Data for creating a sync queue item
 */
export interface CreateSyncQueueData {
  userId: string;
  integrationId: string;
  type: GmailSyncType;
  dateFrom: Date;
  dateTo: Date;
}

/**
 * Sync history record - stores completed sync information for display
 * Collection: gmailSyncHistory/{id}
 */
export interface GmailSyncHistoryRecord {
  id: string;
  userId: string;
  integrationId: string;
  integrationEmail: string;

  // Sync details
  type: GmailSyncType | "auto";
  status: "completed" | "failed" | "partial" | "paused";
  dateFrom: Timestamp;
  dateTo: Timestamp;

  // Results
  emailsSearched: number;
  filesCreated: number;
  attachmentsSkipped: number;
  errors: string[];

  // Timestamps
  startedAt: Timestamp;
  completedAt: Timestamp;
  durationSeconds: number;

  // Trigger info
  triggeredBy?: "import" | "schedule" | "manual";
  triggeredByImportId?: string;
}

/**
 * Aggregated sync stats for an integration (computed from files)
 */
export interface IntegrationSyncStats {
  totalFilesImported: number;
  filesExtracted: number;
  filesMatched: number;
  filesWithErrors: number;
  filesNotInvoices: number;
}
