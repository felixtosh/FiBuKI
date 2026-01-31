import { Timestamp } from "firebase/firestore";
import { EmailSearchPattern } from "./email-integration";
import { NoReceiptCategoryId } from "./no-receipt-category";

/**
 * Matching algorithm source identifier
 */
export type MatchSource = "iban" | "vatId" | "website" | "emailDomain" | "name" | "pattern" | "manual";

/**
 * How a partner was matched to a transaction
 */
export type MatchedBy = "auto" | "manual" | "suggestion";

/**
 * External registry identifiers
 */
export interface ExternalIds {
  /** Austrian Firmenbuch number */
  justizOnline?: string;
  /** EU company registry ID */
  euCompany?: string;
  /** LEI (Legal Entity Identifier) */
  lei?: string;
}

/**
 * Address structure for partners
 */
export interface PartnerAddress {
  street?: string;
  city?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2 country code */
  country: string;
}

/**
 * Source details for global partners (crowdsourced data)
 */
export interface SourceDetails {
  /** User IDs who contributed to this partner's data */
  contributingUserIds: string[];
  /** Confidence score (0-100) based on contribution count and consistency */
  confidence: number;
  /** When the data was last verified */
  verifiedAt?: Timestamp;
  /** Admin who verified, if any */
  verifiedBy?: string;
}

/**
 * Global partner - shared across all users
 * Collection: /globalPartners/{id}
 */
export interface GlobalPartner {
  id: string;

  /** Primary display name */
  name: string;

  /** Alternative names (trade names, abbreviations) */
  aliases: string[];

  /** Business address */
  address?: PartnerAddress;

  /** Country of incorporation (ISO 3166-1 alpha-2) */
  country?: string;

  /** VAT identification number (with country prefix, e.g., ATU12345678) */
  vatId?: string;

  /** Known IBANs associated with this partner */
  ibans: string[];

  /** Website URL (normalized - no protocol, no www) */
  website?: string;

  /** External registry identifiers */
  externalIds?: ExternalIds;

  /** How this data was sourced */
  source: "manual" | "user_promoted" | "external_registry" | "preset";

  /** Details about data sourcing */
  sourceDetails: SourceDetails;

  /** Static patterns for matching transactions (from presets or admin-defined) */
  patterns?: MatchPattern[];

  /** Active status (soft delete) */
  isActive: boolean;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Base pattern for matching transactions
 * Used by both global (static) and user (learned) partners
 */
export interface MatchPattern {
  /** Glob-style pattern, e.g., "google*cloud*" or "*netflix*" */
  pattern: string;

  /**
   * Which transaction field to match against (DEPRECATED)
   * Patterns now match against all text fields combined, no penalties.
   * Kept optional for backward compatibility with existing patterns.
   */
  field?: "partner" | "name";

  /** Confidence score (0-100) */
  confidence: number;

  /**
   * Exclusion patterns - if any of these match, the main pattern is ignored.
   * Example: pattern="*google*" with exclude=["*google*ads*"] matches "Google Cloud" but not "Google Ads".
   * Note: Better-matching partners with higher confidence should naturally win;
   * exclusions are for edge cases where that doesn't work.
   */
  exclude?: string[];
}

/**
 * AI-learned pattern for matching transactions (extends base pattern)
 */
export interface LearnedPattern extends MatchPattern {
  /** When this pattern was learned */
  createdAt: Timestamp;

  /** Transaction IDs that contributed to learning this pattern */
  sourceTransactionIds: string[];

  /** Patterns that exclude this match (antipatterns from manual removals) */
  excludePatterns?: string[];
}

/**
 * File source type for tracking where files come from
 */
export type FileSourceType = "local" | "gmail" | "browser";

/**
 * Result type for file source patterns (used for strategy-specific searches).
 */
export type FileSourceResultType =
  | "local_file"
  | "gmail_attachment"
  | "gmail_html_invoice"
  | "gmail_invoice_link"
  | "browser_invoice";

/**
 * Learned pattern for finding files from a specific source.
 * Used to auto-match files when a partner is assigned to a transaction.
 */
export interface FileSourcePattern {
  /** Where to search for files */
  sourceType: FileSourceType;

  /** Search pattern - glob for local files, search query for Gmail */
  pattern: string;

  /** For Gmail: which integration (account) to search */
  integrationId?: string;

  /** What kind of result this pattern was learned from */
  resultType?: FileSourceResultType;

  /** Confidence score (0-100) based on successful uses */
  confidence: number;

  /** Number of times this pattern successfully found matches */
  usageCount: number;

  /** Transaction IDs where this pattern was used to find files */
  sourceTransactionIds: string[];

  /** When pattern was created */
  createdAt: Timestamp;

  /** Last time pattern was used successfully */
  lastUsedAt: Timestamp;
}

/**
 * Status of an invoice source
 */
export type InvoiceSourceStatus = "active" | "paused" | "error" | "needs_login";

/**
 * How an invoice source was added
 */
export type InvoiceSourceType = "manual" | "email_link" | "browser_detected";

/**
 * How invoice frequency was determined
 */
export type FrequencySource = "inferred" | "manual";

/**
 * An invoice source URL associated with a partner.
 * Used for periodic automated invoice fetching via browser extension.
 */
export interface InvoiceSource {
  /** Unique ID for this source */
  id: string;

  /** The URL to fetch invoices from (e.g., billing portal) */
  url: string;

  /** Domain extracted from URL for display */
  domain: string;

  /** Human-readable label (e.g., "Google Admin Billing") */
  label?: string;

  /** When this source was first discovered/added */
  discoveredAt: Timestamp;

  /** How this source was added */
  sourceType: InvoiceSourceType;

  /** If converted from an invoiceLink, the original message ID for reference */
  fromInvoiceLinkMessageId?: string;

  // === Frequency & Scheduling ===

  /** Inferred invoice frequency in days (e.g., 30 for monthly) */
  inferredFrequencyDays?: number;

  /** How frequency was determined */
  frequencySource?: FrequencySource;

  /** Number of invoices used to infer frequency */
  frequencyDataPoints?: number;

  /** When this source was last successfully fetched */
  lastFetchedAt?: Timestamp;

  /** When the next fetch should occur (calculated from frequency) */
  nextExpectedAt?: Timestamp;

  /** Number of successful fetches */
  successfulFetches: number;

  /** Number of failed fetch attempts */
  failedFetches: number;

  // === Status ===

  /** Current status of this source */
  status: InvoiceSourceStatus;

  /** Last error message if status is error */
  lastError?: string;

  /** When status last changed */
  statusChangedAt?: Timestamp;
}

/**
 * Record of a transaction that was manually removed from this partner.
 * Used as negative training signal (false positive) for pattern learning.
 */
export interface ManualRemoval {
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
 * Record of a file that was manually removed from this partner.
 * Used as negative training signal (false positive) for file-partner matching.
 */
export interface ManualFileRemoval {
  /** ID of the file that was removed */
  fileId: string;

  /** When the removal happened */
  removedAt: Timestamp;

  /** Snapshot of file's extracted partner name (for pattern learning) */
  extractedPartner: string | null;

  /** Snapshot of file's filename (for reference) */
  fileName: string;
}

/**
 * User-specific partner
 * Collection: /partners/{id} with userId field
 */
export interface UserPartner {
  id: string;

  /** Owner of this partner record */
  userId: string;

  /** Optional link to global partner (if this is a local copy) */
  globalPartnerId?: string;

  /** Display name */
  name: string;

  /** Alternative names */
  aliases: string[];

  /** Business address */
  address?: PartnerAddress;

  /** Country (ISO 3166-1 alpha-2) */
  country?: string;

  /** VAT identification number */
  vatId?: string;

  /** Whether VAT ID was verified via EU VIES service */
  viesVerified?: boolean;

  /** When VAT ID was verified via VIES */
  viesVerifiedAt?: Timestamp;

  /** Known IBANs */
  ibans: string[];

  /** Website URL (normalized) */
  website?: string;

  /** User notes */
  notes?: string;

  /** Default category to assign for transactions with this partner */
  defaultCategoryId?: string;

  /** AI-learned patterns for matching transactions */
  learnedPatterns?: LearnedPattern[];

  /** When patterns were last updated */
  patternsUpdatedAt?: Timestamp;

  /**
   * Transactions user explicitly removed from this partner.
   * Used as negative training signal (false positives) for pattern learning.
   * Capped at 50 entries.
   */
  manualRemovals?: ManualRemoval[];

  /**
   * Files user explicitly removed from this partner.
   * Used as negative training signal (false positives) for file-partner matching.
   * Capped at 50 entries.
   */
  manualFileRemovals?: ManualFileRemoval[];

  /**
   * Learned email search patterns for finding invoices from this partner.
   * Used to auto-suggest Gmail searches when connecting files.
   * @deprecated Use fileSourcePatterns instead for unified file source tracking
   */
  emailSearchPatterns?: EmailSearchPattern[];

  /** When email search patterns were last updated */
  emailPatternsUpdatedAt?: Timestamp;

  /**
   * Learned file source patterns for finding files from this partner.
   * Supports both local files (glob patterns) and Gmail (search queries).
   * Used to auto-match files when a partner is assigned to a transaction.
   */
  fileSourcePatterns?: FileSourcePattern[];

  /** When file source patterns were last updated */
  fileSourcePatternsUpdatedAt?: Timestamp;

  /**
   * Known email domains for this partner (e.g., ["amazon.de", "amazon.com"]).
   * Learned from files matched to transactions with this partner.
   * Used to boost confidence when matching files from known sender domains.
   */
  emailDomains?: string[];

  /** When email domains were last updated */
  emailDomainsUpdatedAt?: Timestamp;

  /**
   * Invoice links discovered from emails (for manual download).
   * Found by precision search Strategy 4 (email_invoice) when analyzing email content.
   * User can click these to download invoices that weren't attachments.
   */
  invoiceLinks?: import("./precision-search").DiscoveredInvoiceLink[];

  /** When invoice links were last updated */
  invoiceLinksUpdatedAt?: Timestamp;

  /**
   * Invoice sources for automated periodic fetching.
   * URLs where this partner's invoices can be downloaded.
   * Managed in the partner detail panel's Files tab.
   */
  invoiceSources?: InvoiceSource[];

  /** When invoice sources were last updated */
  invoiceSourcesUpdatedAt?: Timestamp;

  /** Active status (soft delete) */
  isActive: boolean;

  /**
   * If set, this partner is derived from identity settings and auto-syncs.
   * Value indicates which identity entity this partner comes from:
   * - "personalEntity": The user's personal identity
   * - "company:{entityId}": A company entity with the given ID
   * - Legacy: "name" | "companyName" (for backward compatibility)
   * Partners with this field should show "Edit in Identity" instead of edit/delete.
   */
  identitySourceField?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;

  // === RESOLUTION PREFERENCE ===

  /**
   * How this partner's transactions are typically resolved (file vs no-receipt).
   * Learned automatically when transactions are marked complete.
   */
  resolutionPreference?: PartnerResolutionPreference;

  // === CATEGORY MATCH RULES ===

  /**
   * Rules for matching this partner's transactions to specific no-receipt categories.
   * Allows conditional category matching based on transaction text patterns.
   * E.g., "Google Ireland" -> "Private" only when "*youtubepremium*" matches
   */
  categoryMatchRules?: CategoryMatchRule[];

  /** When category match rules were last updated */
  categoryMatchRulesUpdatedAt?: Timestamp;

  /**
   * Transactions manually removed from category assignments for this partner.
   * Used as negative training signal for category pattern learning.
   * Different from manualRemovals (which is for partner matching).
   * Capped at 50 entries per category.
   */
  categoryManualRemovals?: PartnerCategoryManualRemoval[];
}

/**
 * Partner suggestion stored on transaction
 */
export interface PartnerSuggestion {
  /** Partner ID (can be global or user) */
  partnerId: string;
  /** Whether this is a global or user partner */
  partnerType: "global" | "user";
  /** Confidence score (0-100) */
  confidence: number;
  /** Which matching algorithm found this */
  source: MatchSource;
}

/**
 * Form data for creating/editing a partner
 */
export interface PartnerFormData {
  name: string;
  aliases?: string[];
  address?: PartnerAddress;
  country?: string;
  vatId?: string;
  ibans?: string[];
  website?: string;
  notes?: string;
  defaultCategoryId?: string;
}

/**
 * Form data for creating/editing a global partner (admin)
 */
export interface GlobalPartnerFormData extends PartnerFormData {
  externalIds?: ExternalIds;
  source?: "manual" | "user_promoted" | "external_registry" | "preset";
}

/**
 * Filters for partner queries
 */
export interface PartnerFilters {
  /** Text search in name, aliases, vatId */
  search?: string;
  /** Filter by VAT ID presence */
  hasVatId?: boolean;
  /** Filter by country */
  country?: string;
  /** Filter by IBAN presence */
  hasIban?: boolean;
}

/**
 * Result of partner matching
 */
export interface PartnerMatchResult {
  partnerId: string;
  partnerType: "global" | "user";
  partnerName: string;
  confidence: number;
  source: MatchSource;
}

/**
 * Candidate partner for promotion to global
 */
export interface PromotionCandidate {
  /** Document ID */
  id: string;
  /** The user partner being considered for promotion */
  userPartner: UserPartner;
  /** Number of users with similar partner data */
  userCount: number;
  /** Aggregated confidence score for promotion */
  confidence: number;
  /** Status of promotion review */
  status: "pending" | "approved" | "rejected";
  /** When this candidate was created */
  createdAt: Timestamp;
  /** When reviewed */
  reviewedAt?: Timestamp;
  /** Admin who reviewed */
  reviewedBy?: string;
}

// ============================================================================
// Partner Resolution Preference Types
// ============================================================================

/**
 * How a partner's transactions are typically resolved.
 * - "file_required": Partner typically needs file attachments (invoices, receipts)
 * - "no_receipt": Partner typically doesn't need receipts (bank fees, internal transfers)
 * - "mixed": Partner has both types (sometimes file, sometimes no-receipt)
 * - "unknown": Not enough data yet (< 3 completed transactions)
 */
export type PartnerResolutionType = "file_required" | "no_receipt" | "mixed" | "unknown";

/**
 * Statistics about how transactions with this partner are resolved
 */
export interface PartnerResolutionStats {
  /** Count of transactions resolved with file attachments */
  fileCount: number;
  /** Count of transactions resolved with no-receipt categories */
  noReceiptCount: number;
  /** When stats were last updated */
  updatedAt: Timestamp;
}

/**
 * Learned resolution preference for a partner.
 * Used to predict how new transactions with this partner should be resolved.
 */
export interface PartnerResolutionPreference {
  /** Current resolution type preference */
  type: PartnerResolutionType;
  /** Confidence level (0-100) based on sample size and consistency */
  confidence: number;
  /** Preferred no-receipt category ID (if type is "no_receipt" or "mixed") */
  preferredNoReceiptCategoryId?: string | null;
  /** Preferred no-receipt category template ID (for quick lookup) */
  preferredNoReceiptCategoryTemplateId?: NoReceiptCategoryId | null;
  /** Resolution statistics */
  stats: PartnerResolutionStats;
}

// ============================================================================
// Partner Category Match Rules
// ============================================================================

/**
 * Rule for matching a partner's transactions to a specific no-receipt category.
 * Stored on the partner, allows conditional category matching based on transaction text.
 *
 * Example: Google Ireland Limited partner can have a rule that matches "Private" category
 * only when transaction text contains "*youtubepremium*", but not for Google Cloud or Ads.
 */
export interface CategoryMatchRule {
  /** Category ID this rule matches to */
  categoryId: string;

  /** Category template ID for quick lookup */
  categoryTemplateId: NoReceiptCategoryId;

  /** Glob patterns that must match for this category (e.g., "*youtubepremium*") */
  patterns: string[];

  /** Patterns that exclude this category (e.g., "*business*", "*cloud*") */
  excludePatterns?: string[];

  /** Confidence score (0-100) based on training data */
  confidence: number;

  /** When this rule was created */
  createdAt: Timestamp;

  /** When this rule was last updated */
  updatedAt: Timestamp;

  /** Transaction IDs that contributed to learning this rule (positive examples) */
  sourceTransactionIds: string[];

  /** Transaction IDs that were manually removed (negative examples) */
  negativeTransactionIds?: string[];
}

/**
 * Record of a transaction that was manually removed from a category assignment.
 * Stored on the partner, used as negative training signal for category pattern learning.
 * Different from ManualRemoval (which is for partner matching, not category matching).
 */
export interface PartnerCategoryManualRemoval {
  /** ID of the transaction that was removed */
  transactionId: string;

  /** Category ID it was removed from */
  categoryId: string;

  /** When the removal happened */
  removedAt: Timestamp;

  /** Snapshot of transaction's partner field (for pattern learning) */
  partner: string | null;

  /** Snapshot of transaction's name field (for pattern learning) */
  name: string;

  /** Snapshot of transaction's reference field (for pattern learning) */
  reference: string | null;
}
