import { Timestamp } from "firebase/firestore";
import { AmountFormatConfig } from "./import";

/**
 * Type of financial account
 */
export type AccountKind = "bank_account" | "credit_card";

/**
 * Credit card brand/network
 */
export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "other";

/**
 * A transaction source represents a bank account or financial data source.
 * All transactions must be associated with a source for proper organization
 * and deduplication.
 */
export interface TransactionSource {
  id: string;

  /** Display name for the account, e.g., "Erste Bank Business" */
  name: string;

  /** Type of account: bank account or credit card */
  accountKind: AccountKind;

  /** International Bank Account Number for deduplication (optional for credit cards) */
  iban?: string;

  /** For credit cards: optional reference to the linked bank account */
  linkedSourceId?: string;

  /** For credit cards: last 4 digits of card number */
  cardLast4?: string;

  /** For credit cards: card brand/network */
  cardBrand?: CardBrand;

  /** Auto-created partner for this source (for pattern learning + reconciliation) */
  sourcePartnerId?: string;

  /** How transactions are imported */
  type: "csv" | "api";

  /** Configuration for API-based connectors (future use) */
  apiConfig?: ApiConnectorConfig;

  /** Saved column mappings from previous imports */
  fieldMappings?: SavedFieldMapping;

  /** Default currency for transactions, e.g., "EUR" */
  currency: string;

  /** Whether this source is active and visible */
  isActive: boolean;

  /** Owner of this source */
  userId: string;

  /** Opening balance in cents, used as anchor for balance calculations */
  openingBalance?: number | null;
  /** Date of the opening balance */
  openingBalanceDate?: Timestamp | null;
  /** How the opening balance was determined */
  openingBalanceSource?: "csv_derived" | "api_fetched" | "manual" | null;
  /** Latest known balance in cents, for quick display */
  latestBalance?: number | null;
  /** Date of the latest known balance */
  latestBalanceDate?: Timestamp | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Configuration for API-based transaction connectors
 */
export type ApiConnectorConfig =
  | TrueLayerConnectorConfig
  | GenericConnectorConfig;

/**
 * TrueLayer-specific connector configuration
 */
export interface TrueLayerConnectorConfig {
  provider: "truelayer";
  /** TrueLayer account ID */
  accountId: string;
  /** Institution identifier */
  institutionId: string;
  institutionName: string;
  institutionLogo?: string;
  /** Access token (should be encrypted in production) */
  accessToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken: string;
  /** When the access token expires */
  tokenExpiresAt: Timestamp;
  /** When the overall connection expires (90 days PSD2 limit) */
  expiresAt: Timestamp;
  /** Last successful sync */
  lastSyncAt?: Timestamp;
  /** Last sync error if any */
  lastSyncError?: string;
}

/**
 * Generic connector configuration for future providers
 */
export interface GenericConnectorConfig {
  /** Provider identifier: "plaid" | "custom" etc. */
  provider: string;

  /** Encrypted credentials or tokens */
  credentials: Record<string, string>;

  /** Last successful sync timestamp */
  lastSyncAt?: Timestamp;

  /** Cron expression for scheduled syncs, e.g., "0 6 * * *" */
  syncSchedule?: string;

  /** Provider-specific settings */
  settings?: Record<string, unknown>;
}

/**
 * Persisted column mappings for a source, saved after successful imports.
 * Allows users to skip manual mapping on subsequent imports.
 */
export interface SavedFieldMapping {
  /**
   * CSV column header -> our field key mapping
   * e.g., { "Buchungsdatum": "date", "Betrag": "amount" }
   */
  mappings: Record<string, string>;

  /**
   * CSV column header -> format parser ID
   * e.g., { "Buchungsdatum": "de", "Betrag": "de" }
   */
  formats?: Record<string, string>;

  /** @deprecated Use formats instead - kept for backwards compatibility */
  dateFormat?: string;

  /** @deprecated Use formats instead - kept for backwards compatibility */
  amountFormat?: AmountFormatConfig;

  /** When these mappings were last used */
  lastUsedAt: Timestamp;
}

/**
 * Form data for creating a new source
 */
export interface SourceFormData {
  name: string;
  accountKind: AccountKind;
  /** For bank accounts: IBAN */
  iban?: string;
  /** For credit cards: linked bank account ID */
  linkedSourceId?: string;
  /** For credit cards: last 4 digits */
  cardLast4?: string;
  /** For credit cards: card brand */
  cardBrand?: CardBrand;
  /** Primary currency for the account */
  currency: string;
  type: "csv" | "api";
  /** Opening balance in cents (for manual entry) */
  openingBalance?: number;
  /** Opening balance date as ISO string (for manual entry) */
  openingBalanceDate?: string;
}
