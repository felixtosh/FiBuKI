/**
 * Plaid Banking Provider
 *
 * Implements BankingProvider interface for Plaid.
 *
 * Key differences from other providers:
 * - Uses Plaid Link (client-side modal) instead of redirect flow
 * - Uses /transactions/sync with cursor for incremental updates
 * - Amount sign is INVERTED: Plaid positive=outflow, our system positive=credit
 */

import {
  BankingProviderId,
  BankingProviderInfo,
  BankingInstitution,
  BankingAccount,
  BankingTransaction,
  BankingConfig,
  PlaidBankingConfig,
  BankingError,
} from "../types";
import {
  BaseBankingProvider,
  CreateConnectionOptions,
  CreateConnectionResult,
  CallbackOptions,
  CallbackResult,
  FetchTransactionsOptions,
} from "../provider";
import {
  PlaidClient,
  PlaidTransaction,
  PlaidInstitution,
  PlaidAccount,
  PlaidEnvironment,
} from "@/lib/plaid/client";

// EU countries supported by Plaid
const PLAID_EU_COUNTRIES = ["GB", "DE", "FR", "ES", "NL", "IE"];

/**
 * Plaid Provider Implementation
 */
export class PlaidProvider extends BaseBankingProvider {
  readonly id: BankingProviderId = "plaid";

  private client: PlaidClient | null = null;

  constructor() {
    super();
    this.initializeClient();
  }

  private initializeClient(): void {
    const clientId = process.env.PLAID_CLIENT_ID;
    const secret = process.env.PLAID_SECRET;
    const environment = (process.env.PLAID_ENVIRONMENT || "sandbox") as PlaidEnvironment;

    if (clientId && secret) {
      this.client = new PlaidClient({
        clientId,
        secret,
        environment,
      });
    }
  }

  getInfo(): BankingProviderInfo {
    return {
      id: "plaid",
      name: "Plaid",
      description: "Connect to your bank via Plaid. Strong coverage in UK and EU.",
      supportedCountries: PLAID_EU_COUNTRIES,
      logoUrl: "/images/providers/plaid-logo.svg",
      isEnabled: this.isConfigured(),
      requiresReauth: true,
      reauthDays: 90,
    };
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  private getClient(): PlaidClient {
    if (!this.client) {
      throw new BankingError(
        "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET environment variables.",
        "plaid",
        "NOT_CONFIGURED"
      );
    }
    return this.client;
  }

  async listInstitutions(countryCode: string): Promise<BankingInstitution[]> {
    const client = this.getClient();
    const upperCountry = countryCode.toUpperCase();

    // Check if country is supported
    if (!PLAID_EU_COUNTRIES.includes(upperCountry)) {
      return [];
    }

    try {
      const { institutions } = await client.getInstitutions([upperCountry], 500);
      return institutions.map((inst) => this.transformInstitution(inst));
    } catch (error) {
      console.error("[Plaid] Error listing institutions:", error);
      return [];
    }
  }

  async getInstitution(institutionId: string): Promise<BankingInstitution> {
    const client = this.getClient();

    const { institution } = await client.getInstitution(
      institutionId,
      PLAID_EU_COUNTRIES
    );
    return this.transformInstitution(institution);
  }

  /**
   * For Plaid, createConnection creates a link_token.
   * The actual connection happens client-side via Plaid Link modal.
   */
  async createConnection(
    options: CreateConnectionOptions
  ): Promise<CreateConnectionResult> {
    const client = this.getClient();

    // Extract user ID from reference (format: conn_userId_timestamp)
    const userId = options.reference?.split("_")[1] || "unknown";

    const response = await client.createLinkToken({
      userId,
      countryCodes: PLAID_EU_COUNTRIES,
      language: options.language || "en",
      redirectUri: options.redirectUrl,
    });

    // For Plaid, the "authUrl" is a special scheme that tells the frontend
    // to open Plaid Link with this token (not a regular redirect URL)
    return {
      connectionId: response.link_token,
      authUrl: `plaid-link://${response.link_token}`,
      expiresAt: new Date(response.expiration),
    };
  }

  /**
   * For Plaid, handleCallback receives the public_token from Plaid Link
   * and exchanges it for an access_token.
   */
  async handleCallback(options: CallbackOptions): Promise<CallbackResult> {
    const client = this.getClient();

    if (options.error) {
      return {
        success: false,
        status: "rejected",
        error: options.errorDescription || options.error,
      };
    }

    // The "code" for Plaid is the public_token from Plaid Link
    if (!options.code) {
      return {
        success: false,
        status: "rejected",
        error: "No public token received from Plaid Link",
      };
    }

    try {
      // Exchange public_token for access_token
      const exchangeResponse = await client.exchangePublicToken(options.code);

      // Get accounts to verify connection
      const { accounts } = await client.getAccounts(exchangeResponse.access_token);

      return {
        success: true,
        status: "linked",
        accountIds: accounts.map((a) => a.account_id),
        providerData: {
          accessToken: exchangeResponse.access_token,
          itemId: exchangeResponse.item_id,
        },
      };
    } catch (error) {
      return {
        success: false,
        status: "rejected",
        error: error instanceof Error ? error.message : "Token exchange failed",
      };
    }
  }

  async getConnectionStatus(connectionId: string): Promise<{
    status: "pending" | "authorizing" | "linked" | "expired" | "rejected" | "suspended";
    accountIds?: string[];
  }> {
    // For Plaid, connectionId is the link_token which can't be used to check status
    // Status is determined after token exchange via stored credentials
    return { status: "pending" };
  }

  /**
   * Get accounts - requires access_token stored in config
   * This is called after connection is established
   */
  async getAccounts(connectionId: string): Promise<BankingAccount[]> {
    // For Plaid, we need the accessToken, not connectionId
    // This method is typically called with the stored config accessToken
    throw new BankingError(
      "Use getAccountsWithAccessToken for Plaid provider",
      "plaid",
      "USE_ACCESS_TOKEN"
    );
  }

  /**
   * Get accounts using access token directly
   */
  async getAccountsWithAccessToken(accessToken: string): Promise<BankingAccount[]> {
    const client = this.getClient();
    const { accounts } = await client.getAccounts(accessToken);
    return accounts.map((a) => this.transformAccount(a));
  }

  /**
   * Fetch transactions using cursor-based sync
   */
  async fetchTransactions(
    options: FetchTransactionsOptions
  ): Promise<BankingTransaction[]> {
    const client = this.getClient();
    const config = options.config as PlaidBankingConfig;

    if (config.provider !== "plaid") {
      throw new BankingError(
        "Invalid config provider for Plaid",
        "plaid",
        "INVALID_CONFIG"
      );
    }

    const allTransactions: BankingTransaction[] = [];
    let cursor = config.syncCursor;
    let hasMore = true;

    // Paginate through all available transactions
    while (hasMore) {
      const response = await client.syncTransactions(config.accessToken, cursor);

      // Transform added and modified transactions
      for (const tx of [...response.added, ...response.modified]) {
        // Only include transactions for the requested account
        // Skip pending transactions - they may change
        if (tx.account_id === options.accountId && !tx.pending) {
          allTransactions.push(this.transformTransaction(tx));
        }
      }

      cursor = response.next_cursor;
      hasMore = response.has_more;
    }

    // Store the new cursor for next sync
    // This is read by the caller (banking-ops.ts) to update the config
    (config as PlaidBankingConfig & { _newCursor?: string })._newCursor = cursor;

    return allTransactions;
  }

  async revokeConnection(connectionId: string): Promise<void> {
    // For revoking, we need the accessToken, not connectionId
    console.log(`[Plaid] Cannot revoke connection without accessToken: ${connectionId}`);
  }

  /**
   * Revoke connection using access token
   */
  async revokeConnectionWithAccessToken(accessToken: string): Promise<void> {
    const client = this.getClient();
    await client.removeItem(accessToken);
  }

  // =========================================
  // Private Helpers - Transformations
  // =========================================

  private transformInstitution(inst: PlaidInstitution): BankingInstitution {
    return {
      id: inst.institution_id,
      name: inst.name,
      logoUrl: inst.logo || undefined,
      countries: inst.country_codes || [],
      maxHistoryDays: 730, // Plaid supports up to 2 years
      providerId: "plaid",
    };
  }

  private transformAccount(account: PlaidAccount): BankingAccount {
    return {
      id: account.account_id,
      accountNumber: account.mask ? `****${account.mask}` : undefined,
      ownerName: account.official_name || account.name,
      currency: account.balances?.iso_currency_code || "EUR",
      type: this.mapAccountType(account.type, account.subtype),
      status: "active",
      providerId: "plaid",
    };
  }

  /**
   * Transform Plaid transaction to BankingTransaction
   *
   * CRITICAL: Flip the amount sign!
   * - Plaid: positive = money leaving account (debit/expense)
   * - Our system: positive = money entering account (credit/income)
   */
  private transformTransaction(tx: PlaidTransaction): BankingTransaction {
    // FLIP THE SIGN - this is the key transformation
    const amount = -tx.amount;

    // Get counterparty name from various sources
    const counterpartyName =
      tx.merchant_name || tx.counterparties?.[0]?.name || tx.name;

    return {
      id: tx.transaction_id,
      internalId: tx.payment_meta?.ppd_id,
      bookingDate: tx.date,
      amount,
      currency: tx.iso_currency_code || "EUR",
      counterpartyName,
      description: tx.name,
      reference: tx.payment_meta?.reference_number,
      bankTransactionCode: tx.personal_finance_category?.detailed,
      rawData: tx as unknown as Record<string, unknown>,
    };
  }

  private mapAccountType(
    type: string,
    subtype?: string
  ): "checking" | "savings" | "credit_card" | "other" {
    if (type === "credit") return "credit_card";
    if (type === "depository") {
      if (subtype === "savings") return "savings";
      return "checking";
    }
    return "other";
  }
}

// =========================================
// Singleton Export
// =========================================

let plaidProvider: PlaidProvider | null = null;

export function getPlaidProvider(): PlaidProvider {
  if (!plaidProvider) {
    plaidProvider = new PlaidProvider();
  }
  return plaidProvider;
}
