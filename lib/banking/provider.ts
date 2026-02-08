/**
 * Banking Provider Interface
 *
 * All banking providers must implement this interface to be used
 * in the multi-provider banking system.
 */

import {
  BankingProviderId,
  BankingProviderInfo,
  BankingInstitution,
  BankingConnection,
  BankingAccount,
  BankingTransaction,
  BankingConfig,
  SyncResult,
} from "./types";

/**
 * Options for creating a new bank connection
 */
export interface CreateConnectionOptions {
  /** Institution to connect to */
  institutionId: string;
  /** URL to redirect after authorization */
  redirectUrl: string;
  /** Max days of transaction history to request */
  maxHistoryDays?: number;
  /** User's preferred language (ISO 639-1) */
  language?: string;
  /** Optional reference for tracking */
  reference?: string;
}

/**
 * Result of creating a connection
 */
export interface CreateConnectionResult {
  /** Provider-specific connection ID */
  connectionId: string;
  /** URL for user to authorize */
  authUrl: string;
  /** When the authorization link expires */
  expiresAt: Date;
  /** Any provider-specific data to store */
  providerData?: Record<string, unknown>;
}

/**
 * Options for handling OAuth callback
 */
export interface CallbackOptions {
  /** Provider-specific connection ID */
  connectionId: string;
  /** Authorization code (if applicable) */
  code?: string;
  /** Error code (if authorization failed) */
  error?: string;
  /** Error description */
  errorDescription?: string;
}

/**
 * Result of handling callback
 */
export interface CallbackResult {
  /** Whether authorization was successful */
  success: boolean;
  /** Updated connection status */
  status: BankingConnection["status"];
  /** Account IDs if available */
  accountIds?: string[];
  /** Error message if failed */
  error?: string;
  /** Provider-specific data to update */
  providerData?: Record<string, unknown>;
}

/**
 * Options for fetching transactions
 */
export interface FetchTransactionsOptions {
  /** Account ID to fetch transactions for */
  accountId: string;
  /** Start date (ISO format) */
  dateFrom?: string;
  /** End date (ISO format) */
  dateTo?: string;
  /** Provider-specific config */
  config: BankingConfig;
}

/**
 * Banking Provider Interface
 *
 * Each provider (finAPI, TrueLayer, Plaid) implements this interface
 * to provide a consistent API for banking operations.
 */
export interface BankingProvider {
  /** Provider identifier */
  readonly id: BankingProviderId;

  /**
   * Get provider information for UI display
   */
  getInfo(): BankingProviderInfo;

  /**
   * Check if provider is properly configured (has credentials)
   */
  isConfigured(): boolean;

  /**
   * List available financial institutions for a country
   * @param countryCode - ISO 3166-1 alpha-2 country code
   */
  listInstitutions(countryCode: string): Promise<BankingInstitution[]>;

  /**
   * Get a specific institution by ID
   */
  getInstitution(institutionId: string): Promise<BankingInstitution>;

  /**
   * Create a new bank connection (requisition/auth link)
   * Returns the authorization URL for the user
   */
  createConnection(options: CreateConnectionOptions): Promise<CreateConnectionResult>;

  /**
   * Handle OAuth callback after user authorization
   */
  handleCallback(options: CallbackOptions): Promise<CallbackResult>;

  /**
   * Get connection status from provider
   */
  getConnectionStatus(connectionId: string): Promise<{
    status: BankingConnection["status"];
    accountIds?: string[];
  }>;

  /**
   * Get accounts available in a connection
   */
  getAccounts(connectionId: string): Promise<BankingAccount[]>;

  /**
   * Fetch transactions for an account
   */
  fetchTransactions(options: FetchTransactionsOptions): Promise<BankingTransaction[]>;

  /**
   * Check if a connection needs re-authentication
   */
  checkReauthRequired(config: BankingConfig): {
    required: boolean;
    expiresAt?: Date;
    daysRemaining?: number;
  };

  /**
   * Revoke/delete a connection
   */
  revokeConnection(connectionId: string): Promise<void>;

  /**
   * Refresh access token if needed (for OAuth providers)
   */
  refreshTokenIfNeeded?(config: BankingConfig): Promise<BankingConfig | null>;
}

/**
 * Abstract base class with common functionality
 */
export abstract class BaseBankingProvider implements BankingProvider {
  abstract readonly id: BankingProviderId;

  abstract getInfo(): BankingProviderInfo;
  abstract isConfigured(): boolean;
  abstract listInstitutions(countryCode: string): Promise<BankingInstitution[]>;
  abstract getInstitution(institutionId: string): Promise<BankingInstitution>;
  abstract createConnection(options: CreateConnectionOptions): Promise<CreateConnectionResult>;
  abstract handleCallback(options: CallbackOptions): Promise<CallbackResult>;
  abstract getConnectionStatus(connectionId: string): Promise<{
    status: BankingConnection["status"];
    accountIds?: string[];
  }>;
  abstract getAccounts(connectionId: string): Promise<BankingAccount[]>;
  abstract fetchTransactions(options: FetchTransactionsOptions): Promise<BankingTransaction[]>;
  abstract revokeConnection(connectionId: string): Promise<void>;

  /**
   * Default implementation - check config expiry
   */
  checkReauthRequired(config: BankingConfig): {
    required: boolean;
    expiresAt?: Date;
    daysRemaining?: number;
  } {
    const expiresAt = config.expiresAt.toDate();
    const now = new Date();
    const daysRemaining = Math.floor(
      (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    return {
      required: daysRemaining <= 0,
      expiresAt,
      daysRemaining: Math.max(0, daysRemaining),
    };
  }
}
