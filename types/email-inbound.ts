import { Timestamp } from "firebase/firestore";

/**
 * Inbound email address for receiving invoices via email forwarding.
 * Users forward invoices to this address, and attachments + email body
 * are automatically processed and converted to files.
 *
 * Collection: /inboundEmailAddresses/{id}
 */
export interface InboundEmailAddress {
  id: string;
  userId: string;

  /** The full generated email address (e.g., invoices-abc123@taxstudio.app) */
  email: string;

  /** The random prefix part of the email for lookup (e.g., "abc123") */
  emailPrefix: string;

  /** User-friendly display name for this address */
  displayName?: string;

  /** Whether this address is active and accepting emails */
  isActive: boolean;

  // === Stats ===

  /** Total number of emails received at this address */
  emailsReceived: number;

  /** Total number of files created from received emails */
  filesCreated: number;

  /** Timestamp of last received email */
  lastEmailAt?: Timestamp;

  // === Settings ===

  /**
   * Optional list of allowed sender domains.
   * If set, only emails from these domains will be processed.
   * Empty array = allow all domains.
   */
  allowedDomains?: string[];

  /** Maximum emails per day (default: 100) */
  dailyLimit: number;

  /** Current count of emails received today */
  todayCount: number;

  /** Date string (YYYY-MM-DD) for daily count reset */
  todayDate?: string;

  // === Timestamps ===

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Log entry for a received inbound email.
 * Tracks processing status and results for audit/debugging.
 *
 * Collection: /inboundEmailLogs/{id}
 */
export interface InboundEmailLog {
  id: string;
  userId: string;

  /** Reference to the inbound email address */
  inboundAddressId: string;

  // === Email Metadata ===

  /** Email Message-ID header (for deduplication) */
  messageId: string;

  /** Sender email address */
  from: string;

  /** Sender display name if available */
  fromName?: string;

  /** Email subject line */
  subject: string;

  /** When the email was received */
  receivedAt: Timestamp;

  // === Processing Status ===

  /**
   * Processing status:
   * - received: Email received, not yet processed
   * - processing: Currently being processed
   * - completed: Successfully processed
   * - failed: Processing failed (see error field)
   * - rejected: Email rejected (see rejectionReason field)
   */
  status: "received" | "processing" | "completed" | "failed" | "rejected";

  // === Results ===

  /** File IDs created from attachments */
  filesCreated: string[];

  /** File ID if email body was converted to PDF */
  bodyConvertedToFile?: string;

  /** Number of attachments processed */
  attachmentsProcessed: number;

  // === Errors ===

  /** Error message if status is "failed" */
  error?: string;

  /**
   * Rejection reason if status is "rejected":
   * - rate_limit: Daily limit exceeded
   * - domain_blocked: Sender domain not in allowlist
   * - invalid_address: Email address not found
   * - duplicate: Email with same Message-ID already processed
   */
  rejectionReason?:
    | "rate_limit"
    | "domain_blocked"
    | "invalid_address"
    | "duplicate";

  // === Timestamps ===

  createdAt: Timestamp;
}

/**
 * Data for creating a new inbound email address. The daily limit and the
 * counters are the server's (#626).
 */
export interface CreateInboundEmailAddressData {
  /** Optional display name */
  displayName?: string;

  /** Optional allowed sender domains */
  allowedDomains?: string[];
}

/**
 * Data for updating an inbound email address: the only fields the
 * `updateInboundEmailAddress` callable writes (#626).
 */
export interface UpdateInboundEmailAddressData {
  /** Update display name */
  displayName?: string;

  /** Update allowed domains */
  allowedDomains?: string[];

  /** Pause/resume the address */
  isActive?: boolean;
}

/**
 * Stats summary for an inbound email address
 */
export interface InboundEmailStats {
  /** Total emails received (all time) */
  totalEmails: number;

  /** Total files created (all time) */
  totalFiles: number;

  /** Emails received today */
  todayEmails: number;

  /** Daily limit */
  dailyLimit: number;

  /** Last email timestamp */
  lastEmailAt?: Timestamp;

  /** Recent email counts (last 7 days) */
  recentActivity?: {
    date: string;
    count: number;
  }[];
}
