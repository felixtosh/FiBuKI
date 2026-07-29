/**
 * TrueLayer Data API Client
 * https://docs.truelayer.com/
 */

import {
  TrueLayerProvider,
  TrueLayerAccount,
  TrueLayerTransaction,
  TrueLayerTokenResponse,
  TrueLayerResponse,
} from "@/types/truelayer";

// TrueLayer uses different domains for sandbox vs production
const AUTH_URL = process.env.TRUELAYER_CLIENT_ID?.startsWith("sandbox-")
  ? "https://auth.truelayer-sandbox.com"
  : "https://auth.truelayer.com";

const API_URL = process.env.TRUELAYER_CLIENT_ID?.startsWith("sandbox-")
  ? "https://api.truelayer-sandbox.com"
  : "https://api.truelayer.com";

/**
 * TrueLayer API Client
 */
export class TrueLayerClient {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private redirectUri: string
  ) {}

  /**
   * Get the authorization URL for user to connect their bank
   */
  getAuthUrl(providerId?: string, state?: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: "info accounts balance transactions offline_access",
      response_mode: "form_post",
    });

    if (providerId) {
      params.set("providers", providerId);
    }

    if (state) {
      params.set("state", state);
    }

    return `${AUTH_URL}/?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string): Promise<TrueLayerTokenResponse> {
    const response = await fetch(`${AUTH_URL}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        code,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error_description || "Failed to exchange code");
    }

    return response.json();
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<TrueLayerTokenResponse> {
    const response = await fetch(`${AUTH_URL}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error_description || "Failed to refresh token");
    }

    return response.json();
  }

  /**
   * Make authenticated API request
   */
  private async request<T>(
    accessToken: string,
    path: string
  ): Promise<TrueLayerResponse<T>> {
    const response = await fetch(`${API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error_description || error.error || `API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get list of accounts
   */
  async getAccounts(accessToken: string): Promise<TrueLayerAccount[]> {
    const response = await this.request<TrueLayerAccount>(accessToken, "/data/v1/accounts");
    return response.results;
  }

  /**
   * Get account by ID
   */
  async getAccount(accessToken: string, accountId: string): Promise<TrueLayerAccount> {
    const response = await this.request<TrueLayerAccount>(
      accessToken,
      `/data/v1/accounts/${encodeURIComponent(accountId)}`
    );
    return response.results[0];
  }

  /**
   * Get transactions for an account
   */
  async getTransactions(
    accessToken: string,
    accountId: string,
    from?: string,
    to?: string
  ): Promise<TrueLayerTransaction[]> {
    let path = `/data/v1/accounts/${encodeURIComponent(accountId)}/transactions`;
    const params = new URLSearchParams();

    if (from) params.set("from", from);
    if (to) params.set("to", to);

    if (params.toString()) {
      path += `?${params.toString()}`;
    }

    const response = await this.request<TrueLayerTransaction>(accessToken, path);
    return response.results;
  }

  /**
   * Get pending transactions for an account
   */
  async getPendingTransactions(
    accessToken: string,
    accountId: string
  ): Promise<TrueLayerTransaction[]> {
    const response = await this.request<TrueLayerTransaction>(
      accessToken,
      `/data/v1/accounts/${encodeURIComponent(accountId)}/transactions/pending`
    );
    return response.results;
  }

  /**
   * Get account balance
   */
  async getBalance(
    accessToken: string,
    accountId: string
  ): Promise<{ current: number; available: number; currency: string }> {
    const response = await this.request<{
      current: number;
      available: number;
      currency: string;
    }>(accessToken, `/data/v1/accounts/${encodeURIComponent(accountId)}/balance`);
    return response.results[0];
  }

  /**
   * Get provider info from access token metadata
   */
  async getMetadata(accessToken: string): Promise<{
    provider: { provider_id: string; display_name: string; logo_uri: string };
  }> {
    const response = await fetch(`${API_URL}/data/v1/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error("Failed to get metadata");
    }

    return response.json();
  }
}

/**
 * Get list of supported providers (banks) for a country
 */
export async function getProviders(country?: string): Promise<TrueLayerProvider[]> {
  const clientId = process.env.TRUELAYER_CLIENT_ID;

  if (!clientId) {
    throw new Error("TrueLayer client ID not configured");
  }

  const isSandbox = clientId.startsWith("sandbox-");
  const authUrl = isSandbox
    ? "https://auth.truelayer-sandbox.com"
    : "https://auth.truelayer.com";

  let url = `${authUrl}/api/providers`;
  if (country) {
    url += `?country=${country.toLowerCase()}`;
  }

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch providers");
  }

  return response.json();
}

/**
 * Create a TrueLayer client instance
 */
export function getTrueLayerClient(): TrueLayerClient {
  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;
  const redirectUri = process.env.TRUELAYER_REDIRECT_URL || "http://localhost:3000/api/truelayer/callback";

  if (!clientId || !clientSecret) {
    throw new Error("TrueLayer credentials not configured");
  }

  return new TrueLayerClient(clientId, clientSecret, redirectUri);
}

/**
 * Get redirect URL for callbacks
 */
export function getRedirectUrl(): string {
  return process.env.TRUELAYER_REDIRECT_URL || "http://localhost:3000/api/truelayer/callback";
}
