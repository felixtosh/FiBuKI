/**
 * Banking Provider Abstraction Layer
 *
 * Provides a unified interface for multiple Open Banking providers
 * (finAPI, TrueLayer, Plaid, etc.)
 */

import { Timestamp } from "firebase/firestore";

// =========================================
// PROVIDER IDENTIFICATION
// =========================================

/**
 * Supported banking data providers
 */
export type BankingProviderId = "truelayer" | "plaid" | "finapi";

/**
 * Provider metadata for UI display
 */
export interface BankingProviderInfo {
  id: BankingProviderId;
  name: string;
  description: string;
  /** Countries where this provider is available (ISO 3166-1 alpha-2) */
  supportedCountries: string[];
  /** Provider logo URL */
  logoUrl?: string;
  /** Whether provider is currently enabled/configured */
  isEnabled: boolean;
  /** Whether the provider requires re-authentication periodically */
  requiresReauth: boolean;
  /** Max days before re-auth required (e.g., 90 for PSD2) */
  reauthDays?: number;
}

// =========================================
// INSTITUTIONS / BANKS
// =========================================

/**
 * A financial institution (bank) available through a provider
 */
export interface BankingInstitution {
  /** Provider-specific institution ID */
  id: string;
  /** Display name */
  name: string;
  /** Bank Identifier Code (SWIFT/BIC) */
  bic?: string;
  /** Logo URL */
  logoUrl?: string;
  /** Countries where available */
  countries: string[];
  /** Maximum transaction history days available */
  maxHistoryDays: number;
  /** Which provider this institution is from */
  providerId: BankingProviderId;
}

// =========================================
// CONNECTIONS (Requisitions/Auth Links)
// =========================================

/**
 * Connection status - unified across providers
 */
export type ConnectionStatus =
  | "pending"      // Waiting for user authorization
  | "authorizing"  // User is in the bank's auth flow
  | "linked"       // Successfully connected
  | "expired"      // Connection has expired
  | "rejected"     // User rejected or error occurred
  | "suspended";   // Temporarily suspended

/**
 * A connection request to a bank - stored in Firestore
 */
export interface BankingConnection {
  id: string;
  /** Which provider this connection is through */
  providerId: BankingProviderId;
  /** Provider-specific connection ID (requisitionId, etc.) */
  providerConnectionId: string;
  /** Institution details */
  institutionId: string;
  institutionName: string;
  institutionLogo?: string;
  /** Current status */
  status: ConnectionStatus;
  /** URL for user to authorize (if pending) */
  authUrl?: string;
  /** Account IDs retrieved after authorization */
  accountIds: string[];
  /** When the connection expires */
  expiresAt: Timestamp;
  /** Provider-specific metadata */
  providerData?: Record<string, unknown>;
  /** Optional: existing source ID to link (for re-auth) */
  linkToSourceId?: string;
  /** Owner */
  userId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// =========================================
// ACCOUNTS
// =========================================

/**
 * A bank account retrieved through a provider
 */
export interface BankingAccount {
  /** Provider-specific account ID */
  id: string;
  /** IBAN (if available) */
  iban?: string;
  /** Account number (if no IBAN) */
  accountNumber?: string;
  /** Sort code (UK) */
  sortCode?: string;
  /** Account holder name */
  ownerName?: string;
  /** Account currency */
  currency: string;
  /** Account type */
  type: "checking" | "savings" | "credit_card" | "other";
  /** Account status */
  status: "active" | "inactive" | "error";
  /** Which provider this account is from */
  providerId: BankingProviderId;
}

// =========================================
// TRANSACTIONS
// =========================================

/**
 * A transaction from a banking provider
 * Normalized format before transformation to app Transaction
 */
export interface BankingTransaction {
  /** Provider-specific transaction ID */
  id: string;
  /** Internal reference (for deduplication) */
  internalId?: string;
  /** Booking date (when transaction was posted) */
  bookingDate: string;
  /** Value date (when amount affected balance) */
  valueDate?: string;
  /** Amount (positive = credit, negative = debit) */
  amount: number;
  /** Currency code */
  currency: string;
  /** Counterparty name (creditor or debtor) */
  counterpartyName?: string;
  /** Counterparty IBAN */
  counterpartyIban?: string;
  /** Transaction description/reference */
  description?: string;
  /** Additional reference info */
  reference?: string;
  /** Bank's transaction code */
  bankTransactionCode?: string;
  /** Raw provider data for debugging */
  rawData?: Record<string, unknown>;
}

// =========================================
// PROVIDER CONFIGURATION
// =========================================

/**
 * Base configuration for API-connected sources
 */
export interface BaseBankingConfig {
  /** Which provider this config is for */
  provider: BankingProviderId;
  /** Provider-specific account ID */
  accountId: string;
  /** Institution identifier */
  institutionId: string;
  institutionName: string;
  institutionLogo?: string;
  /** When the connection expires */
  expiresAt: Timestamp;
  /** Last successful sync */
  lastSyncAt?: Timestamp;
  /** Last sync error if any */
  lastSyncError?: string;
}

/**
 * TrueLayer-specific configuration
 */
export interface TrueLayerBankingConfig extends BaseBankingConfig {
  provider: "truelayer";
  /** TrueLayer access token (encrypted) */
  accessToken: string;
  /** TrueLayer refresh token (encrypted) */
  refreshToken: string;
  /** When access token expires */
  tokenExpiresAt: Timestamp;
}

/**
 * Plaid-specific configuration
 */
export interface PlaidBankingConfig extends BaseBankingConfig {
  provider: "plaid";
  /** Plaid access token */
  accessToken: string;
  /** Plaid item ID */
  itemId: string;
  /** Cursor for /transactions/sync incremental updates */
  syncCursor?: string;
}

/**
 * finAPI-specific configuration
 */
export interface FinapiBankingConfig extends BaseBankingConfig {
  provider: "finapi";
  /** finAPI bank connection ID */
  bankConnectionId: number;
  /** finAPI user access token */
  userAccessToken: string;
  /** finAPI user refresh token */
  userRefreshToken: string;
  /** When user access token expires */
  tokenExpiresAt: Timestamp;
  /** finAPI user ID (auto-created per our user) */
  finapiUserId: string;
}

/**
 * Union type for all provider configs
 */
export type BankingConfig =
  | TrueLayerBankingConfig
  | PlaidBankingConfig
  | FinapiBankingConfig;

// =========================================
// SYNC RESULTS
// =========================================

/**
 * Result of a transaction sync operation
 */
export interface SyncResult {
  /** Number of new transactions imported */
  imported: number;
  /** Number of duplicate transactions skipped */
  skipped: number;
  /** Total transactions fetched from provider */
  total: number;
  /** Error message if sync partially failed */
  error?: string;
  /** Whether re-authentication is required */
  needsReauth?: boolean;
}

// =========================================
// ERROR TYPES
// =========================================

/**
 * Base error for banking operations
 */
export class BankingError extends Error {
  constructor(
    message: string,
    public readonly providerId: BankingProviderId,
    public readonly code?: string
  ) {
    super(message);
    this.name = "BankingError";
  }
}

/**
 * Re-authentication required
 */
export class ReauthRequiredError extends BankingError {
  constructor(
    providerId: BankingProviderId,
    public readonly sourceId: string,
    public readonly expiresAt: Date
  ) {
    super(`Re-authentication required for ${providerId}`, providerId, "REAUTH_REQUIRED");
    this.name = "ReauthRequiredError";
  }
}

/**
 * Rate limit exceeded
 */
export class RateLimitError extends BankingError {
  constructor(
    providerId: BankingProviderId,
    public readonly retryAfterSeconds: number
  ) {
    super(`Rate limit exceeded for ${providerId}`, providerId, "RATE_LIMIT");
    this.name = "RateLimitError";
  }
}

/**
 * Institution not available
 */
export class InstitutionError extends BankingError {
  constructor(
    providerId: BankingProviderId,
    public readonly institutionId: string,
    message: string
  ) {
    super(message, providerId, "INSTITUTION_ERROR");
    this.name = "InstitutionError";
  }
}
