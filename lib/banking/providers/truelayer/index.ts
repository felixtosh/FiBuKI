/**
 * TrueLayer Banking Provider
 *
 * Adapter for TrueLayer Data API
 * https://docs.truelayer.com/
 */

import { Timestamp } from "firebase/firestore";
import {
  BankingProviderId,
  BankingProviderInfo,
  BankingInstitution,
  BankingAccount,
  BankingTransaction,
  BankingConfig,
  TrueLayerBankingConfig,
  BankingError,
} from "../../types";
import {
  BankingProvider,
  BaseBankingProvider,
  CreateConnectionOptions,
  CreateConnectionResult,
  CallbackOptions,
  CallbackResult,
  FetchTransactionsOptions,
} from "../../provider";
import {
  TrueLayerClient,
  TrueLayerAccount,
  TrueLayerTransaction,
  TrueLayerProvider as TLProvider,
} from "./client";

// Supported countries for TrueLayer (UK + EU)
const TRUELAYER_COUNTRIES = [
  "GB", // United Kingdom - primary market
  "IE", // Ireland
  "FR", // France
  "DE", // Germany
  "ES", // Spain
  "IT", // Italy
  "NL", // Netherlands
  "BE", // Belgium
  "AT", // Austria
  "PT", // Portugal
  "FI", // Finland
  "LT", // Lithuania
  "PL", // Poland
  "NO", // Norway
];

// Default scopes for data access
const DEFAULT_SCOPES = [
  "info",
  "accounts",
  "balance",
  "transactions",
  "offline_access", // For refresh tokens
];

/**
 * TrueLayer Provider Implementation
 */
export class TrueLayerProvider extends BaseBankingProvider implements BankingProvider {
  readonly id: BankingProviderId = "truelayer";

  private client: TrueLayerClient | null = null;
  private redirectUrl: string = "";
  private isSandbox: boolean = false;

  // Cache for providers list
  private providersCache: Map<string, { data: BankingInstitution[]; timestamp: number }> =
    new Map();
  private readonly CACHE_TTL = 1000 * 60 * 60; // 1 hour

  constructor() {
    super();
    this.initializeClient();
  }

  private initializeClient(): void {
    const clientId = process.env.TRUELAYER_CLIENT_ID;
    const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;
    this.redirectUrl = process.env.TRUELAYER_REDIRECT_URL || "";
    this.isSandbox = process.env.TRUELAYER_SANDBOX === "true";

    if (clientId && clientSecret) {
      this.client = new TrueLayerClient(clientId, clientSecret, this.isSandbox);
    }
  }

  getInfo(): BankingProviderInfo {
    return {
      id: "truelayer",
      name: "TrueLayer",
      description:
        "Open Banking via TrueLayer. Strong UK/EU coverage with excellent conversion rates.",
      supportedCountries: TRUELAYER_COUNTRIES,
      logoUrl: "https://asset.brandfetch.io/idGDqsGP3d/idqm7gA2G8.svg",
      isEnabled: this.isConfigured(),
      requiresReauth: true,
      reauthDays: 90, // PSD2 requirement
    };
  }

  isConfigured(): boolean {
    return this.client !== null && this.redirectUrl !== "";
  }

  private getClient(): TrueLayerClient {
    if (!this.client) {
      throw new BankingError(
        "TrueLayer is not configured. Set TRUELAYER_CLIENT_ID and TRUELAYER_CLIENT_SECRET environment variables.",
        "truelayer",
        "NOT_CONFIGURED"
      );
    }
    return this.client;
  }

  async listInstitutions(countryCode: string): Promise<BankingInstitution[]> {
    const client = this.getClient();
    const cacheKey = countryCode.toUpperCase();

    // Check cache
    const cached = this.providersCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      const providers = await client.listProviders();

      // Filter by country and transform
      const institutions = providers
        .filter((p) => p.country === cacheKey)
        .map((p) => this.transformProvider(p));

      // Cache results
      this.providersCache.set(cacheKey, {
        data: institutions,
        timestamp: Date.now(),
      });

      return institutions;
    } catch (error) {
      // If we have stale cache, return it on error
      if (cached) {
        return cached.data;
      }
      throw error;
    }
  }

  async getInstitution(institutionId: string): Promise<BankingInstitution> {
    const client = this.getClient();

    try {
      const providers = await client.listProviders();
      const provider = providers.find((p) => p.provider_id === institutionId);

      if (!provider) {
        throw new BankingError(
          `Institution ${institutionId} not found`,
          "truelayer",
          "INSTITUTION_NOT_FOUND"
        );
      }

      return this.transformProvider(provider);
    } catch (error) {
      throw error;
    }
  }

  async createConnection(options: CreateConnectionOptions): Promise<CreateConnectionResult> {
    const client = this.getClient();

    // Generate unique state for tracking
    const state = options.reference || `tl_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Generate auth URL
    const authUrl = client.generateAuthUrl({
      redirectUri: options.redirectUrl || this.redirectUrl,
      scope: DEFAULT_SCOPES,
      providerId: options.institutionId,
      state,
    });

    // TrueLayer doesn't have a pre-connection ID like requisition-based providers
    // We use the state as the connection ID and store tokens after callback
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 90); // PSD2 max

    return {
      connectionId: state,
      authUrl,
      expiresAt,
      providerData: {
        providerId: options.institutionId,
        redirectUri: options.redirectUrl || this.redirectUrl,
      },
    };
  }

  async handleCallback(options: CallbackOptions): Promise<CallbackResult> {
    const client = this.getClient();

    // Handle errors from callback
    if (options.error) {
      return {
        success: false,
        status: "rejected",
        error: options.errorDescription || options.error,
      };
    }

    if (!options.code) {
      return {
        success: false,
        status: "rejected",
        error: "No authorization code received",
      };
    }

    try {
      // Exchange code for tokens
      // Note: We need the redirect URI that was used in the auth request
      // This should be passed in providerData or retrieved from storage
      const redirectUri = this.redirectUrl; // TODO: Get from connection storage

      const tokenResponse = await client.exchangeCode(options.code, redirectUri);

      // Get accounts to verify connection worked
      const accounts = await client.getAccounts(tokenResponse.access_token);

      // Calculate token expiry
      const tokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);

      return {
        success: true,
        status: "linked",
        accountIds: accounts.map((a) => a.account_id),
        providerData: {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          tokenExpiresAt: tokenExpiresAt.toISOString(),
          scope: tokenResponse.scope,
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          success: false,
          status: "rejected",
          error: error.message,
        };
      }
      throw error;
    }
  }

  async getConnectionStatus(connectionId: string): Promise<{
    status: "pending" | "authorizing" | "linked" | "expired" | "rejected" | "suspended";
    accountIds?: string[];
  }> {
    // TrueLayer doesn't have a dedicated connection status endpoint
    // The status is determined by whether we have valid tokens
    // This would need to be checked against stored connection data
    return {
      status: "pending", // Default to pending, actual status comes from stored data
    };
  }

  async getAccounts(connectionId: string): Promise<BankingAccount[]> {
    // This method needs access token from stored connection
    // In practice, this is called with config that has the token
    throw new BankingError(
      "Use getAccountsWithToken for TrueLayer",
      "truelayer",
      "USE_TOKEN_METHOD"
    );
  }

  /**
   * Get accounts using access token directly
   */
  async getAccountsWithToken(accessToken: string): Promise<BankingAccount[]> {
    const client = this.getClient();

    try {
      const accounts = await client.getAccounts(accessToken);
      return accounts.map((a) => this.transformAccount(a));
    } catch (error) {
      throw error;
    }
  }

  async fetchTransactions(options: FetchTransactionsOptions): Promise<BankingTransaction[]> {
    const client = this.getClient();
    const config = options.config as TrueLayerBankingConfig;

    if (config.provider !== "truelayer") {
      throw new BankingError(
        "Invalid config provider for TrueLayer",
        "truelayer",
        "INVALID_CONFIG"
      );
    }

    try {
      // Check if token needs refresh
      const accessToken = await this.getValidAccessToken(config);

      const transactions = await client.getTransactions(accessToken, options.accountId, {
        from: options.dateFrom,
        to: options.dateTo,
      });

      return transactions.map((tx) => this.transformTransaction(tx));
    } catch (error) {
      throw error;
    }
  }

  async revokeConnection(connectionId: string): Promise<void> {
    // TrueLayer revocation requires access token
    // This would need to be called with the token from stored config
    // For now, just log that we're "revoking"
    console.log(`[TrueLayer] Revoking connection ${connectionId}`);
  }

  /**
   * Revoke connection using access token
   */
  async revokeConnectionWithToken(accessToken: string): Promise<void> {
    const client = this.getClient();

    try {
      await client.deleteCredentials(accessToken);
    } catch {
      // Ignore errors - credentials may already be revoked
    }
  }

  /**
   * Refresh token if needed and return valid access token
   */
  async refreshTokenIfNeeded(config: BankingConfig): Promise<BankingConfig | null> {
    if (config.provider !== "truelayer") return null;

    const tlConfig = config as TrueLayerBankingConfig;
    const now = new Date();
    const tokenExpiry = tlConfig.tokenExpiresAt.toDate();

    // Refresh if token expires in less than 5 minutes
    if (tokenExpiry.getTime() - now.getTime() > 5 * 60 * 1000) {
      return null; // Token still valid
    }

    const client = this.getClient();

    try {
      const tokenResponse = await client.refreshToken(tlConfig.refreshToken);
      const newExpiry = new Date(Date.now() + tokenResponse.expires_in * 1000);

      return {
        ...tlConfig,
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token || tlConfig.refreshToken,
        tokenExpiresAt: Timestamp.fromDate(newExpiry),
      };
    } catch {
      // Refresh failed - re-auth required
      return null;
    }
  }

  // =========================================
  // Private Helpers
  // =========================================

  private transformProvider(provider: TLProvider): BankingInstitution {
    return {
      id: provider.provider_id,
      name: provider.display_name,
      logoUrl: provider.logo_uri,
      countries: [provider.country],
      maxHistoryDays: 90, // TrueLayer standard
      providerId: "truelayer",
    };
  }

  private transformAccount(account: TrueLayerAccount): BankingAccount {
    return {
      id: account.account_id,
      iban: account.account_number?.iban,
      accountNumber: account.account_number?.number,
      sortCode: account.account_number?.sort_code,
      currency: account.currency,
      type: this.mapAccountType(account.account_type),
      status: "active",
      providerId: "truelayer",
    };
  }

  private transformTransaction(tx: TrueLayerTransaction): BankingTransaction {
    // TrueLayer uses positive amounts with DEBIT/CREDIT type
    const amount = tx.transaction_type === "DEBIT" ? -Math.abs(tx.amount) : Math.abs(tx.amount);

    return {
      id: tx.transaction_id,
      bookingDate: tx.timestamp.split("T")[0],
      valueDate: tx.timestamp.split("T")[0],
      amount,
      currency: tx.currency,
      counterpartyName: tx.merchant_name,
      description: tx.description,
      bankTransactionCode: tx.transaction_category,
      rawData: tx as unknown as Record<string, unknown>,
    };
  }

  private mapAccountType(
    type: TrueLayerAccount["account_type"]
  ): "checking" | "savings" | "credit_card" | "other" {
    switch (type) {
      case "TRANSACTION":
      case "BUSINESS_TRANSACTION":
        return "checking";
      case "SAVINGS":
      case "BUSINESS_SAVINGS":
        return "savings";
      default:
        return "other";
    }
  }

  private async getValidAccessToken(config: TrueLayerBankingConfig): Promise<string> {
    const refreshed = await this.refreshTokenIfNeeded(config);
    if (refreshed) {
      return (refreshed as TrueLayerBankingConfig).accessToken;
    }
    return config.accessToken;
  }
}

/**
 * Singleton instance
 */
let trueLayerProvider: TrueLayerProvider | null = null;

export function getTrueLayerProvider(): TrueLayerProvider {
  if (!trueLayerProvider) {
    trueLayerProvider = new TrueLayerProvider();
  }
  return trueLayerProvider;
}

// Re-export client types
export * from "./client";
