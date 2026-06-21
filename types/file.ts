import { Timestamp } from "firebase/firestore";
import {
  FileSourceType,
  FileSourceResultType,
  PartnerSuggestion,
} from "./partner";
import { InvoiceDirection } from "./user-data";

/**
 * Entity information extracted from a document (issuer or recipient).
 * Used to store both parties so we can determine the counterparty in post-processing.
 */
export interface ExtractedEntity {
  /** Company or person name */
  name: string | null;
  /** VAT identification number */
  vatId: string | null;
  /** Full address */
  address: string | null;
  /** IBAN (typically only issuer has this visible) */
  iban?: string | null;
  /** Website domain */
  website?: string | null;
}

/**
 * Raw text for an extracted entity (for PDF search/highlight)
 */
export interface ExtractedEntityRaw {
  name?: string | null;
  vatId?: string | null;
  address?: string | null;
  iban?: string | null;
  website?: string | null;
}

/**
 * A single extracted invoice line item.
 * Monetary fields are stored in cents.
 */
export interface ExtractedLineItem {
  description: string;
  quantity?: number | null;
  /** Net unit price before VAT (in cents) */
  unitPrice?: number | null;
  /** VAT rate for this item (0-100), null when unknown */
  vatPercent: number | null;
  /** VAT amount for this item (in cents) */
  vatAmount: number;
  /** Line amount in cents (preferably gross; some extractions provide net) */
  amount: number;
}

/**
 * Match sources for transaction matching - indicates which criteria contributed to a match
 */
export type TransactionMatchSource =
  | "amount_exact"
  | "amount_close"
  | "date_exact"
  | "date_close"
  | "partner"
  | "iban"
  | "reference";

/**
 * A suggested transaction match for a file
 */
export interface TransactionSuggestion {
  transactionId: string;
  confidence: number; // 0-100
  matchSources: TransactionMatchSource[];

  /** Cached transaction info for display (avoids extra lookup) */
  preview: {
    date: Timestamp;
    amount: number;
    currency: string;
    name: string;
    partner: string | null;
  };
}

/**
 * A file (PDF/image) uploaded to FiBuKI.
 * Files are standalone entities that can be connected to multiple transactions.
 * Collection: /files/{id}
 */
export interface TaxFile {
  id: string;

  /** Owner of this file */
  userId: string;

  // === Storage ===

  /** Original filename */
  fileName: string;

  /** MIME type (image/jpeg, image/png, application/pdf) */
  fileType: string;

  /** File size in bytes */
  fileSize: number;

  /** Firebase Storage path */
  storagePath: string;

  /** Public download URL */
  downloadUrl: string;

  /** Thumbnail URL for images/PDFs (optional) */
  thumbnailUrl?: string;

  /** SHA-256 hash of file content for duplicate detection */
  contentHash?: string;

  // === Source Tracking ===

  /** How the file was added to FiBuKI (defaults to "upload" for legacy files) */
  sourceType?: "upload" | "gmail" | "gmail_html_invoice" | "gmail_invoice_link" | "browser" | "email_inbound" | "email_inbound_body" | "fibuki_invoice";

  /** Search pattern/query that produced this file (when known) */
  sourceSearchPattern?: string;

  /** Result type for the original file source */
  sourceResultType?: FileSourceResultType;

  /** For browser imports: original source URL */
  sourceUrl?: string;

  /** For browser imports: source domain */
  sourceDomain?: string;

  /** For browser imports: run ID for the pull session */
  sourceRunId?: string;

  /** For browser imports: collector ID */
  sourceCollectorId?: string;

  /** For Gmail imports: Gmail message ID */
  gmailMessageId?: string;

  /** For Gmail imports: which integration (account) the file came from */
  gmailIntegrationId?: string;

  /** For Gmail imports: email address of the integration account (e.g., "myaccount@gmail.com") */
  gmailIntegrationEmail?: string;

  /** For Gmail imports: email subject */
  gmailSubject?: string;

  /** For Gmail imports: attachment ID (for deduplication) */
  gmailAttachmentId?: string;

  /** For Gmail imports: sender email address */
  gmailSenderEmail?: string;

  /** For Gmail imports: sender email domain (e.g., "amazon.de") */
  gmailSenderDomain?: string;

  /** For Gmail imports: sender display name */
  gmailSenderName?: string;

  /** For Gmail imports: when the email was sent */
  gmailEmailDate?: Timestamp;

  // === Inbound Email Source Tracking ===

  /** For email inbound: the inbound address ID that received this email */
  inboundEmailId?: string;

  /** For email inbound: the email address that received the email */
  inboundEmailAddress?: string;

  /** For email inbound: Message-ID header of the email */
  inboundMessageId?: string;

  /** For email inbound: sender email address */
  inboundFrom?: string;

  /** For email inbound: sender display name */
  inboundFromName?: string;

  /** For email inbound: email subject */
  inboundSubject?: string;

  /** For email inbound: when the email was received */
  inboundReceivedAt?: Timestamp;

  // === AI Extracted Data ===

  /** AI-extracted document date (when the document was issued) */
  extractedDate?: Timestamp | null;

  /** AI-extracted amount in cents */
  extractedAmount?: number | null;

  /** AI-extracted currency code */
  extractedCurrency?: string | null;

  /** AI-extracted VAT percentage (0-100) */
  extractedVatPercent?: number | null;

  /** AI-extracted total VAT amount in cents */
  extractedVatAmount?: number | null;

  /** AI-extracted line items */
  extractedLineItems?: ExtractedLineItem[] | null;

  /** AI-extracted partner/company name */
  extractedPartner?: string | null;

  /** AI-extracted VAT ID */
  extractedVatId?: string | null;

  /** AI-extracted IBAN */
  extractedIban?: string | null;

  /** AI-extracted address */
  extractedAddress?: string | null;

  /** AI-extracted website domain */
  extractedWebsite?: string | null;

  // === Extracted Entities (for counterparty determination) ===

  /**
   * The entity that issued/created the document (letterhead, sender).
   * Contains name, VAT ID, address, IBAN, website.
   */
  extractedIssuer?: ExtractedEntity | null;

  /**
   * The entity that receives the document (bill-to, recipient).
   * Contains name, VAT ID, address.
   */
  extractedRecipient?: ExtractedEntity | null;

  /**
   * Which party matched user data (if any).
   * - "issuer" = user is the sender (outgoing invoice)
   * - "recipient" = user is the receiver (incoming invoice)
   * - null = neither matched (e.g., forwarded invoice, or no user data configured)
   */
  matchedUserAccount?: "issuer" | "recipient" | null;

  /**
   * Raw text as it appears in the document for each field.
   * Used for PDF text search/highlight (since we normalize values for storage).
   * E.g., amount might be stored as 12345 (cents) but raw is "123,45 €"
   */
  extractedRaw?: {
    date?: string | null;
    amount?: string | null;
    vatPercent?: string | null;
    partner?: string | null;
    vatId?: string | null;
    iban?: string | null;
    address?: string | null;
    website?: string | null;
    issuer?: ExtractedEntityRaw | null;
    recipient?: ExtractedEntityRaw | null;
  } | null;

  /**
   * Additional fields extracted from the document beyond standard invoice fields.
   * E.g., invoice number, due date, reference, PO number, etc.
   */
  extractedAdditionalFields?: ExtractedAdditionalField[] | null;

  /** AI-extracted text (OCR result) */
  extractedText?: string | null;

  /** AI confidence score (0-100) */
  extractionConfidence?: number | null;

  /** Whether AI extraction has been completed */
  extractionComplete: boolean;

  /** Error message if extraction failed */
  extractionError?: string | null;

  /** Extracted field locations for overlay rendering */
  extractedFields?: ExtractedFieldLocation[];

  // === Relationships ===

  /** Transaction IDs this file is connected to (denormalized for queries) */
  transactionIds: string[];

  // === Transaction Matching ===

  /** Auto-matched transaction suggestions (stored after extraction) */
  transactionSuggestions?: TransactionSuggestion[];

  /** Whether transaction matching has been completed */
  transactionMatchComplete?: boolean;

  /** When transaction matching was last run */
  transactionMatchedAt?: Timestamp | null;

  /**
   * Transaction IDs that user dismissed as suggestions.
   * @deprecated Use dismissedTransactions instead (which includes timestamps)
   */
  dismissedTransactionIds?: string[];

  /**
   * Dismissed transaction records with timestamps and context.
   * Prevents re-suggesting these transactions to this file.
   * New format — code should handle both dismissedTransactionIds (legacy) and dismissedTransactions.
   */
  dismissedTransactions?: Array<{
    transactionId: string;
    dismissedAt: Timestamp;
    /** Confidence of the suggestion that was dismissed */
    confidence?: number | null;
  }>;

  // === Partner Matching ===

  /** Whether partner matching has been completed (triggers transaction matching) */
  partnerMatchComplete?: boolean;

  /** When partner matching was last run */
  partnerMatchedAt?: Timestamp | null;

  /** Partner suggestions from auto-matching (top 3) */
  partnerSuggestions?: PartnerSuggestion[];

  // === Partner Assignment ===

  /** Assigned partner ID (user or global) */
  partnerId?: string | null;

  /** Partner type (user = custom, global = shared) */
  partnerType?: "user" | "global" | null;

  /** How the partner was matched */
  partnerMatchedBy?: "manual" | "suggestion" | "auto" | "ai" | null;

  /** Confidence score for partner match (0-100) */
  partnerMatchConfidence?: number | null;

  // === Classification ===

  /** Whether AI classification (invoice vs not-invoice) has completed */
  classificationComplete?: boolean;

  /** AI determined this is not an invoice (tax form, spam, etc.) */
  isNotInvoice?: boolean;

  /** Reason why this is not an invoice */
  notInvoiceReason?: string | null;

  /**
   * Invoice direction: incoming (user is recipient) or outgoing (user is issuer).
   * Determined by comparing extracted partner against user data.
   */
  invoiceDirection?: InvoiceDirection;

  // === Fibuki-generated invoices ===

  /** If set, this file is a Fibuki-generated invoice. Points to /invoices/{id}. */
  invoiceId?: string;

  /** When true, file was created by Fibuki (not uploaded). Bypasses extraction trigger. */
  isFibukiGenerated?: boolean;

  // === Soft Delete (for Gmail imports) ===

  /** Soft deletion timestamp - file won't be re-imported if deleted */
  deletedAt?: Timestamp | null;

  // === Metadata ===

  uploadedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Junction collection for File <-> Transaction relationship
 * Collection: /fileConnections/{id}
 *
 * This exists for:
 * 1. Querying "all files for a transaction" efficiently
 * 2. Querying "all transactions for a file" efficiently
 * 3. Storing connection metadata (when connected, how matched)
 */
export interface FileConnection {
  id: string;

  fileId: string;
  transactionId: string;
  userId: string;

  /** How this connection was made */
  connectionType:
    | "manual"
    | "auto_matched"
    | "suggestion_accepted"
    | "gmail_import"
    | "gmail_html_conversion"
    | "email_inbound";

  /** Which matching criteria led to the match (for auto/suggestion) */
  matchSources?: TransactionMatchSource[];

  /** AI confidence if auto-matched (0-100) */
  matchConfidence?: number | null;

  /** Score breakdown by factor (amount, date, partner, iban, reference, hint) */
  scoreBreakdown?: {
    amount: number;
    date: number;
    partner: number;
    iban: number;
    reference: number;
    hint: number;
  };

  /** Whether this transaction was in the file's suggestions at time of manual connection */
  wasSuggested?: boolean;

  /** Confidence of the suggestion at time of manual connection */
  suggestedConfidence?: number | null;

  /** Rank in suggestions list at time of manual connection (0-indexed) */
  suggestedRank?: number | null;

  // === Source Tracking (how the file was found during connection) ===

  /** Where the file was found when connecting */
  sourceType?: FileSourceType;

  /** The search pattern/query used to find this file */
  searchPattern?: string;

  /** For Gmail: which integration (account) was searched */
  gmailIntegrationId?: string;

  /** For Gmail: integration email */
  gmailIntegrationEmail?: string;

  /** For Gmail: message ID containing the attachment */
  gmailMessageId?: string;

  /** For Gmail: sender email address */
  gmailMessageFrom?: string;

  /** For Gmail: sender display name */
  gmailMessageFromName?: string;

  /** Type of result selected during the connection */
  resultType?: FileSourceResultType;

  createdAt: Timestamp;
}

/**
 * Filters for file queries
 */
export interface FileFilters {
  /** Text search in filename, extracted partner */
  search?: string;

  /** Filter by connection status */
  hasConnections?: boolean;

  /** Filter by extraction status */
  extractionComplete?: boolean;

  /** Date range for upload date */
  uploadedFrom?: Date;
  uploadedTo?: Date;

  /** Date range for extracted document date */
  extractedDateFrom?: Date;
  extractedDateTo?: Date;

  /** Include soft-deleted files (default: false) */
  includeDeleted?: boolean;

  /** Show only "not invoice" files */
  isNotInvoice?: boolean;

  /** Filter by assigned partner IDs */
  partnerIds?: string[];

  /** Filter by invoice direction (income = outgoing, expense = incoming) */
  amountType?: "all" | "income" | "expense";
}

/**
 * Form data for creating a file record (after upload to storage)
 */
export interface FileCreateData {
  fileName: string;
  fileType: string;
  fileSize: number;
  storagePath: string;
  downloadUrl: string;
  thumbnailUrl?: string;
  contentHash?: string;

  // Source tracking
  sourceType?: "upload" | "gmail" | "gmail_html_invoice" | "gmail_invoice_link" | "browser" | "email_inbound" | "email_inbound_body" | "fibuki_invoice";
  sourceSearchPattern?: string;
  sourceResultType?: FileSourceResultType;
  sourceUrl?: string;
  sourceDomain?: string;
  sourceRunId?: string;
  sourceCollectorId?: string;
  gmailMessageId?: string;
  gmailIntegrationId?: string;
  gmailIntegrationEmail?: string;
  gmailSubject?: string;
  gmailAttachmentId?: string;
  gmailSenderEmail?: string;
  gmailSenderDomain?: string;
  gmailSenderName?: string;
  gmailEmailDate?: Date;

  // Inbound email tracking
  inboundEmailId?: string;
  inboundEmailAddress?: string;
  inboundMessageId?: string;
  inboundFrom?: string;
  inboundFromName?: string;
  inboundSubject?: string;
  inboundReceivedAt?: Date;
}

/**
 * Data for updating AI extraction results
 */
export interface FileExtractionData {
  extractedDate?: Timestamp | null;
  extractedAmount?: number | null;
  extractedCurrency?: string | null;
  extractedVatPercent?: number | null;
  extractedVatAmount?: number | null;
  extractedLineItems?: ExtractedLineItem[] | null;
  extractedPartner?: string | null;
  extractedVatId?: string | null;
  extractedIban?: string | null;
  extractedAddress?: string | null;
  extractedWebsite?: string | null;
  extractedText?: string | null;

  // Extracted entities (for counterparty determination)
  extractedIssuer?: ExtractedEntity | null;
  extractedRecipient?: ExtractedEntity | null;
  matchedUserAccount?: "issuer" | "recipient" | null;

  extractedRaw?: {
    date?: string | null;
    amount?: string | null;
    vatPercent?: string | null;
    partner?: string | null;
    vatId?: string | null;
    iban?: string | null;
    address?: string | null;
    website?: string | null;
    issuer?: ExtractedEntityRaw | null;
    recipient?: ExtractedEntityRaw | null;
  } | null;
  extractedAdditionalFields?: ExtractedAdditionalField[] | null;
  extractionConfidence?: number | null;
  extractionComplete: boolean;
  extractionError?: string | null;
  extractedFields?: ExtractedFieldLocation[];
}

/**
 * Location of an extracted field on the document for overlay rendering
 */
export interface ExtractedFieldLocation {
  /** Which field this location refers to */
  field: "date" | "amount" | "currency" | "vatPercent" | "partner" | "vatId" | "iban" | "address";

  /** The extracted value as text */
  value: string;

  /** Confidence score (0-1) */
  confidence: number;

  /** Bounding box for overlay rendering */
  boundingBox?: {
    /** Normalized coordinates (0-1) */
    vertices: Array<{ x: number; y: number }>;
    /** Page index for multi-page PDFs */
    pageIndex: number;
  };
}

/**
 * An additional field extracted from a document beyond the standard invoice fields.
 * Used for arbitrary data like invoice numbers, due dates, references, etc.
 */
export interface ExtractedAdditionalField {
  /** Human-readable label for the field (e.g., "Invoice Number", "Due Date") */
  label: string;

  /** The extracted value */
  value: string;

  /** Raw text as it appears in the document (for PDF search) */
  rawValue?: string;
}
