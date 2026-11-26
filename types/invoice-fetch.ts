import type { Timestamp } from "firebase/firestore";

/**
 * Status of an invoice fetch queue item
 */
export type InvoiceFetchStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "needs_login";

/**
 * Queue item for scheduled invoice fetching.
 * Collection: /invoiceFetchQueue/{id}
 *
 * Created by scheduled cloud function when an invoice source is due for fetching.
 * Processed by the browser extension when the user has it active.
 */
export interface InvoiceFetchQueueItem {
  /** Document ID */
  id: string;

  /** Owner user ID */
  userId: string;

  /** Partner this source belongs to */
  partnerId: string;

  /** The specific invoice source being fetched */
  invoiceSourceId: string;

  /** URL to fetch */
  url: string;

  /** Domain for display */
  domain: string;

  /** Current status */
  status: InvoiceFetchStatus;

  /** When this was queued */
  createdAt: Timestamp;

  /** When processing started (extension picked it up) */
  startedAt?: Timestamp;

  /** When processing completed (success or final failure) */
  completedAt?: Timestamp;

  /** Number of files downloaded in this fetch */
  filesDownloaded: number;

  /** File IDs that were created from this fetch */
  fileIds: string[];

  /** Error message if failed */
  error?: string;

  /** Current retry count */
  retryCount: number;

  /** Maximum retries before marking as failed */
  maxRetries: number;
}

/**
 * Data for creating a new fetch queue item
 */
export interface InvoiceFetchQueueCreateData {
  partnerId: string;
  invoiceSourceId: string;
  url: string;
  domain: string;
  maxRetries?: number;
}

/**
 * Result of a fetch attempt (reported by extension)
 */
export interface InvoiceFetchResult {
  success: boolean;
  filesDownloaded: number;
  fileIds: string[];
  error?: string;
  needsLogin?: boolean;
}
