/**
 * Design System - Tool Result Types
 *
 * Shared types for GenUI tool result previews in chat interface.
 */

/**
 * Base transaction context shown in search results
 */
export interface SearchedTransactionContext {
  id: string;
  name: string;
  partner?: string;
  amount: number;
  date: string;
}

/**
 * Local file search candidate
 */
export interface LocalFileCandidate {
  id: string;
  fileId?: string;
  fileName?: string;
  score: number;
  scoreLabel?: "Strong" | "Likely" | null;
  scoreReasons?: string[];
  /** The document total: integer cents when the result says `amountsIn: "cents"` (#616), else euros */
  extractedAmount?: number;
  /** Currency code (e.g., "EUR", "USD") */
  extractedCurrency?: string;
  extractedDate?: string;
  extractedPartner?: string;
  scoreDetails?: string;
  /** True if this file was rejected for the searched transaction */
  isRejected?: boolean;
}

/**
 * Gmail attachment search candidate
 */
export interface GmailAttachmentCandidate {
  id: string;
  messageId?: string;
  attachmentId?: string;
  attachmentFilename?: string;
  attachmentMimeType?: string;
  attachmentSize?: number;
  emailSubject?: string;
  emailFrom?: string;
  emailDate?: string;
  emailSnippet?: string;
  integrationId?: string;
  integrationEmail?: string;
  score: number;
  scoreLabel?: "Strong" | "Likely" | null;
  scoreReasons?: string[];
  scoreDetails?: string;
  alreadyDownloaded?: boolean;
  existingFileId?: string | null;
}

/**
 * Result from searchLocalFiles tool
 */
export interface LocalFilesSearchResult {
  searchType: "local_files";
  /** "cents" since #616; a result saved before carries no unit and its candidate amounts are euros. */
  amountsIn?: "cents";
  strategy?: "partner_files" | "amount_files" | "both";
  searchedTransaction: SearchedTransactionContext;
  summary: string;
  candidates: LocalFileCandidate[];
  totalFound: number;
}

/**
 * Integration that needs reconnection
 */
export interface IntegrationNeedingReauth {
  integrationId: string;
  email: string;
  needsReauth: boolean;
}

/**
 * Result from searchGmailAttachments tool
 */
export interface GmailAttachmentsSearchResult {
  searchType: "gmail_attachments";
  searchedTransaction?: SearchedTransactionContext;
  queriesUsed: string[];
  summary?: string;
  candidates: GmailAttachmentCandidate[];
  totalFound: number;
  integrationCount: number;
  /** True when user has no Gmail integrations connected */
  gmailNotConnected?: boolean;
  /** Integrations that need reauth or are paused */
  integrationsNeedingReauth?: IntegrationNeedingReauth[];
  error?: string;
}

/**
 * Gmail email search candidate (for mail invoices / invoice links)
 */
export interface GmailEmailCandidate {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName?: string | null;
  date: string;
  snippet: string;
  integrationId: string;
  integrationEmail?: string;
  attachmentCount: number;
  classification: {
    hasPdfAttachment: boolean;
    possibleMailInvoice: boolean;
    possibleInvoiceLink: boolean;
    confidence: number;
    matchedKeywords?: string[];
  };
  /** Server-computed match score (when transactionId provided) */
  score?: number;
  /** Score label ("Strong" | "Likely") */
  scoreLabel?: "Strong" | "Likely" | null;
  /** Reasons for the score */
  scoreReasons?: string[];
}

/**
 * Result from searchGmailEmails tool
 */
export interface GmailEmailsSearchResult {
  searchType: "gmail_emails";
  query: string;
  emails: GmailEmailCandidate[];
  totalFound: number;
  integrationCount: number;
  summary?: string;
  /** True when user has no Gmail integrations connected */
  gmailNotConnected?: boolean;
  /** Integrations that need reauth or are paused */
  integrationsNeedingReauth?: IntegrationNeedingReauth[];
  error?: string;
}

/**
 * Transaction result from listTransactions tool
 */
export interface TransactionResult {
  id: string;
  date: string;
  dateFormatted?: string;
  amount: number;
  amountFormatted: string;
  name: string;
  description: string | null;
  partner: string;
  isComplete: boolean;
  hasReceipts: boolean;
}

/**
 * Search suggestion from generateSearchSuggestions tool
 */
export interface SearchSuggestion {
  query: string;
  type: "invoice_number" | "company_name" | "email_domain" | "vat_id" | "iban" | "pattern" | "fallback";
  typeLabel: string;
  score: number;
}

/**
 * Result from generateSearchSuggestions tool
 */
export interface SearchSuggestionsResultData {
  searchType: "search_suggestions";
  transaction: {
    id: string;
    name: string;
    partner?: string;
    amountFormatted: string;
    dateFormatted: string;
  };
  suggestions: SearchSuggestion[];
  queries: string[];
  summary: string;
}

/**
 * File result from listFiles tool
 */
export interface FileResult {
  id: string;
  fileName: string;
  fileType: string;
  date: string | null;
  dateFormatted: string;
  amount: number | null;
  amountFormatted: string | null;
  partnerId: string | null;
  partnerName: string | null;
  transactionIds: string[];
  hasTransaction: boolean;
  extractionComplete: boolean;
  isNotInvoice: boolean;
  uploadedAt: string;
}

/**
 * Result from listFiles tool
 */
export interface FileListResult {
  files: FileResult[];
  total: number;
  hasMore: boolean;
}

/**
 * Props for tool result UI actions
 */
export interface ToolResultUIActions {
  scrollToTransaction?: (id: string) => void;
  openTransactionSheet?: (id: string) => void;
  openFile?: (fileId: string) => void;
  previewFile?: (fileId: string) => void;
}

// ============================================================================
// Partner Results
// ============================================================================

/**
 * Partner result from listPartners/getPartner
 */
export interface PartnerResult {
  id: string;
  name: string;
  aliases?: string[];
  vatId?: string | null;
  website?: string | null;
  country?: string | null;
  ibans?: string[];
  emailDomains?: string[];
  address?: string | null;
}

/**
 * Result from listPartners tool
 */
export interface PartnerListResult {
  partners: PartnerResult[];
  total: number;
}

// ============================================================================
// Company Lookup Results
// ============================================================================

/**
 * Result from lookupCompanyInfo tool
 */
export interface CompanyLookupResult {
  success: boolean;
  searchTerm: string;
  name?: string | null;
  aliases?: string[];
  vatId?: string | null;
  website?: string | null;
  country?: string | null;
  address?: {
    street?: string;
    city?: string;
    postalCode?: string;
    country?: string;
  } | null;
  error?: string;
  message: string;
}

// ============================================================================
// VAT Validation Results
// ============================================================================

/**
 * Result from validateVatId tool
 */
export interface VatValidationResult {
  success: boolean;
  vatId: string;
  isValid: boolean;
  name?: string | null;
  address?: string | { street?: string; postalCode?: string; city?: string; country?: string } | null;
  country?: string | null;
  error?: string | null;
  message: string;
}
