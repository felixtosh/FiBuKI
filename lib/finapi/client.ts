/**
 * finAPI Client
 *
 * Wraps the finAPI Access API for banking connections.
 * Uses Web Form 2.0 for bank authentication.
 *
 * API Docs: https://docs.finapi.io/
 */

// Environment URLs
const FINAPI_ENVIRONMENTS = {
  sandbox: "https://sandbox.finapi.io",
  live: "https://live.finapi.io",
} as const;

// Web Form 2.0 URLs (separate service)
const WEBFORM_ENVIRONMENTS = {
  sandbox: "https://webform-sandbox.finapi.io",
  live: "https://webform.finapi.io",
} as const;

export type FinapiEnvironment = keyof typeof FINAPI_ENVIRONMENTS;

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

export interface FinapiConfig {
  clientId: string;
  clientSecret: string;
  environment: FinapiEnvironment;
}

// =========================================
// RESPONSE TYPES
// =========================================

export interface FinapiTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

export interface FinapiBank {
  id: number;
  name: string;
  bic?: string;
  blz?: string;
  location?: string;
  city?: string;
  isTestBank: boolean;
  popularity: number;
  interfaces: Array<{
    interface: "FINTS_SERVER" | "WEB_SCRAPER" | "XS2A";
    aisAccountTypes?: string[];
  }>;
  bankGroup?: {
    id: number;
    name: string;
  };
  logo?: {
    url: string;
  };
}

export interface FinapiBankList {
  banks: FinapiBank[];
  paging: {
    page: number;
    perPage: number;
    totalPages: number;
    totalCount: number;
  };
}

export interface FinapiAccount {
  id: number;
  bankConnectionId: number;
  accountName?: string;
  iban?: string;
  accountNumber?: string;
  subAccountNumber?: string;
  accountHolderName?: string;
  accountHolderIds?: string[];
  accountCurrency?: string;
  accountType:
    | "Checking"
    | "Savings"
    | "CreditCard"
    | "Security"
    | "Membership"
    | "Loan"
    | "Bausparen"
    | "Insurance";
  balance?: number;
  overdraft?: number;
  overdraftLimit?: number;
  availableFunds?: number;
  isNew: boolean;
  interfaces: Array<{
    interface: "FINTS_SERVER" | "WEB_SCRAPER" | "XS2A";
    status: "UPDATED" | "UPDATED_FIXED" | "DOWNLOAD_IN_PROGRESS" | "DOWNLOAD_FAILED";
    lastSuccessfulUpdate?: string;
  }>;
}

export interface FinapiAccountList {
  accounts: FinapiAccount[];
  paging: {
    page: number;
    perPage: number;
    totalPages: number;
    totalCount: number;
  };
}

export interface FinapiTransaction {
  id: number;
  accountId: number;
  valueDate: string;
  bankBookingDate: string;
  finapiBookingDate: string;
  amount: number;
  currency?: string;
  purpose?: string;
  counterpartName?: string;
  counterpartAccountNumber?: string;
  counterpartIban?: string;
  counterpartBlz?: string;
  counterpartBic?: string;
  counterpartBankName?: string;
  type?: string;
  typeCodeSwift?: string;
  sepaPurposeCode?: string;
  primanota?: string;
  endToEndReference?: string;
  mandateReference?: string;
  creditorId?: string;
  isNew: boolean;
  isPotentialDuplicate: boolean;
  isAdjustingEntry: boolean;
}

export interface FinapiTransactionList {
  transactions: FinapiTransaction[];
  paging: {
    page: number;
    perPage: number;
    totalPages: number;
    totalCount: number;
  };
}

export interface FinapiBankConnection {
  id: number;
  bankId: number;
  name?: string;
  bankingUserId?: string;
  bankingCustomerId?: string;
  bankingPin?: string;
  type: "ONLINE" | "DEMO";
  updateStatus: "IN_PROGRESS" | "READY" | "ERROR";
  categorizationStatus: "IN_PROGRESS" | "PENDING" | "READY";
  lastManualUpdate?: {
    result: "INTERNAL_ERROR" | "BANK_SERVER_REJECTION" | "NO_EXISTING_CHALLENGE" | "INCORRECT_CREDENTIALS";
    errorMessage?: string;
    errorType?: string;
    timestamp: string;
  };
  lastAutoUpdate?: {
    result: string;
    timestamp: string;
  };
  interfaces: Array<{
    interface: "FINTS_SERVER" | "WEB_SCRAPER" | "XS2A";
    loginCredentials?: Array<{
      label: string;
      value: string;
    }>;
    defaultTwoStepProcedureId?: string;
    twoStepProcedures?: Array<{
      procedureId: string;
      procedureName: string;
      procedureChallengeType?: string;
      implicitExecute: boolean;
    }>;
    aisConsent?: {
      status: "PRESENT" | "NOT_PRESENT";
      expiresAt?: string;
    };
    lastManualUpdate?: {
      timestamp: string;
    };
    lastAutoUpdate?: {
      timestamp: string;
    };
    capabilities?: string[];
  }>;
  accountIds: number[];
  owners?: Array<{
    firstName?: string;
    lastName?: string;
    salutation?: string;
    title?: string;
    email?: string;
    dateOfBirth?: string;
    postCode?: string;
    country?: string;
    city?: string;
    street?: string;
    houseNumber?: string;
  }>;
}

export interface FinapiWebForm {
  id: string;
  token: string;
  url: string;
  status: "NOT_YET_OPENED" | "IN_PROGRESS" | "COMPLETED" | "COMPLETED_WITH_ERROR" | "ABORTED" | "TIMED_OUT";
  type: "BANK_CONNECTION_IMPORT" | "BANK_CONNECTION_UPDATE" | "STANDING_ORDER" | "PAYMENT";
  payload?: {
    bankConnectionId?: number;
    errorCode?: string;
    errorMessage?: string;
  };
}

export interface FinapiUser {
  id: string;
  password: string;
  email?: string;
  phone?: string;
  isAutoUpdateEnabled: boolean;
}

export interface FinapiError {
  errors: Array<{
    message: string;
    code: string;
    type: string;
  }>;
}

// =========================================
// CLIENT CLASS
// =========================================

export class FinapiClient {
  private baseUrl: string;
  private webformUrl: string;
  private clientToken: string | null = null;
  private clientTokenExpiry: number = 0;

  constructor(private config: FinapiConfig) {
    this.baseUrl = FINAPI_ENVIRONMENTS[config.environment];
    this.webformUrl = WEBFORM_ENVIRONMENTS[config.environment];
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options?: {
      body?: Record<string, unknown>;
      token?: string;
      params?: Record<string, string | number | boolean | undefined>;
      formData?: URLSearchParams;
    }
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    // Add query params
    if (options?.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          searchParams.append(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {};

    if (options?.formData) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (options?.body) {
      headers["Content-Type"] = "application/json";
    }

    if (options?.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    console.log(`[finAPI] ${sanitizeForLog(method)} ${sanitizeForLog(url)}`);

    const response = await fetch(url, {
      method,
      headers,
      body: options?.formData
        ? options.formData.toString()
        : options?.body
        ? JSON.stringify(options.body)
        : undefined,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`[finAPI] Error response:`, JSON.stringify(data, null, 2));
      const error = data as FinapiError;
      // Handle OAuth error format (error, error_description) as well as finAPI format (errors[])
      const oauthError = data as { error?: string; error_description?: string };
      const message = error.errors?.[0]?.message || oauthError.error_description || oauthError.error || `finAPI error: ${response.status}`;
      throw new Error(message);
    }

    return data as T;
  }

  // =========================================
  // AUTHENTICATION
  // =========================================

  /**
   * Get client access token (for admin operations)
   */
  async getClientToken(): Promise<string> {
    // Return cached token if still valid
    if (this.clientToken && Date.now() < this.clientTokenExpiry - 60000) {
      return this.clientToken;
    }

    const formData = new URLSearchParams();
    formData.append("grant_type", "client_credentials");
    formData.append("client_id", this.config.clientId);
    formData.append("client_secret", this.config.clientSecret);

    const response = await this.request<FinapiTokenResponse>(
      "POST",
      "/api/v2/oauth/token",
      { formData }
    );

    this.clientToken = response.access_token;
    this.clientTokenExpiry = Date.now() + response.expires_in * 1000;

    return response.access_token;
  }

  /**
   * Get user access token
   */
  async getUserToken(
    userId: string,
    password: string
  ): Promise<FinapiTokenResponse> {
    const formData = new URLSearchParams();
    formData.append("grant_type", "password");
    formData.append("client_id", this.config.clientId);
    formData.append("client_secret", this.config.clientSecret);
    formData.append("username", userId);
    formData.append("password", password);

    return this.request<FinapiTokenResponse>("POST", "/api/v2/oauth/token", {
      formData,
    });
  }

  /**
   * Refresh user access token
   */
  async refreshUserToken(refreshToken: string): Promise<FinapiTokenResponse> {
    const formData = new URLSearchParams();
    formData.append("grant_type", "refresh_token");
    formData.append("client_id", this.config.clientId);
    formData.append("client_secret", this.config.clientSecret);
    formData.append("refresh_token", refreshToken);

    return this.request<FinapiTokenResponse>("POST", "/api/v2/oauth/token", {
      formData,
    });
  }

  // =========================================
  // USERS
  // =========================================

  /**
   * Create a finAPI user (one per app user)
   */
  async createUser(
    userId: string,
    password: string,
    email?: string
  ): Promise<FinapiUser> {
    const clientToken = await this.getClientToken();

    return this.request<FinapiUser>("POST", "/api/v2/users", {
      token: clientToken,
      body: {
        id: userId,
        password,
        email,
        isAutoUpdateEnabled: false,
      },
    });
  }

  /**
   * Get user info
   */
  async getUser(userToken: string): Promise<FinapiUser> {
    return this.request<FinapiUser>("GET", "/api/v2/users", {
      token: userToken,
    });
  }

  /**
   * Delete a user
   */
  async deleteUser(userId: string): Promise<void> {
    const clientToken = await this.getClientToken();
    await this.request<void>("DELETE", `/api/v2/users/${userId}`, {
      token: clientToken,
    });
  }

  // =========================================
  // BANKS
  // =========================================

  /**
   * Search/list banks
   */
  async getBanks(options?: {
    search?: string;
    location?: string;
    ids?: number[];
    isTestBank?: boolean;
    page?: number;
    perPage?: number;
  }): Promise<FinapiBankList> {
    const clientToken = await this.getClientToken();

    return this.request<FinapiBankList>("GET", "/api/v2/banks", {
      token: clientToken,
      params: {
        search: options?.search,
        location: options?.location,
        ids: options?.ids?.join(","),
        isTestBank: options?.isTestBank,
        page: options?.page || 1,
        perPage: options?.perPage || 100,
      },
    });
  }

  /**
   * Get bank by ID
   */
  async getBank(bankId: number): Promise<FinapiBank> {
    const clientToken = await this.getClientToken();

    const response = await this.request<FinapiBankList>("GET", "/api/v2/banks", {
      token: clientToken,
      params: { ids: String(bankId) },
    });

    if (!response.banks.length) {
      throw new Error(`Bank ${bankId} not found`);
    }

    return response.banks[0];
  }

  // =========================================
  // WEB FORMS (Bank Connection)
  // =========================================

  /**
   * Create a web form for bank connection import
   * Uses Web Form 2.0 service (separate from main API)
   */
  async createBankConnectionWebForm(
    userToken: string,
    bankId: number | null, // Pre-select bank to skip bank selection in web form
    options?: {
      redirectUrl?: string;
      maxDaysForDownload?: number;
    }
  ): Promise<FinapiWebForm> {
    const url = `${this.webformUrl}/api/webForms/bankConnectionImport`;
    console.log(`[finAPI] POST ${url}`);

    // Web Form 2.0 body format
    const body: Record<string, unknown> = {};

    // Pre-select the bank to skip bank selection in web form
    if (bankId) {
      body.bank = { id: bankId };
    }

    // Add callbacks for redirect after completion
    if (options?.redirectUrl) {
      body.callbacks = {
        finalised: options.redirectUrl,
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`[finAPI] Web Form error:`, JSON.stringify(data, null, 2));
      const error = data as FinapiError;
      throw new Error(error.errors?.[0]?.message || (data as { description?: string }).description || `Web Form error: ${response.status}`);
    }

    // Web Form 2.0 response format differs slightly
    return {
      id: data.id,
      token: "", // Not provided in v2
      url: data.url,
      status: data.status,
      type: data.type,
      payload: data.payload,
    };
  }

  /**
   * Get web form status
   * Uses Web Form 2.0 service
   */
  async getWebForm(webFormId: string, userToken: string): Promise<FinapiWebForm> {
    const url = `${this.webformUrl}/api/webForms/${encodeURIComponent(webFormId)}`;
    console.log(`[finAPI] GET ${sanitizeForLog(url)}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${userToken}`,
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`[finAPI] Web Form status error:`, JSON.stringify(data, null, 2));
      throw new Error((data as FinapiError).errors?.[0]?.message || `Web Form error: ${response.status}`);
    }

    return {
      id: data.id,
      token: "",
      url: data.url,
      status: data.status,
      type: data.type,
      payload: data.payload,
    };
  }

  // =========================================
  // BANK CONNECTIONS
  // =========================================

  /**
   * Get bank connection
   */
  async getBankConnection(
    connectionId: number,
    userToken: string
  ): Promise<FinapiBankConnection> {
    return this.request<FinapiBankConnection>(
      "GET",
      `/api/v2/bankConnections/${connectionId}`,
      { token: userToken }
    );
  }

  /**
   * Get all bank connections
   */
  async getBankConnections(
    userToken: string
  ): Promise<{ connections: FinapiBankConnection[] }> {
    return this.request<{ connections: FinapiBankConnection[] }>(
      "GET",
      "/api/v2/bankConnections",
      { token: userToken }
    );
  }

  /**
   * Update bank connection (refresh data)
   */
  async createBankConnectionUpdateWebForm(
    userToken: string,
    connectionId: number,
    options?: {
      redirectUrl?: string;
    }
  ): Promise<FinapiWebForm> {
    return this.request<FinapiWebForm>(
      "POST",
      "/api/v2/webForms/bankConnectionUpdate",
      {
        token: userToken,
        body: {
          bankConnectionId: connectionId,
          callbacks: options?.redirectUrl
            ? {
                finalised: options.redirectUrl,
              }
            : undefined,
        },
      }
    );
  }

  /**
   * Delete bank connection
   */
  async deleteBankConnection(
    connectionId: number,
    userToken: string
  ): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v2/bankConnections/${connectionId}`,
      { token: userToken }
    );
  }

  // =========================================
  // ACCOUNTS
  // =========================================

  /**
   * Get accounts
   */
  async getAccounts(
    userToken: string,
    options?: {
      bankConnectionIds?: number[];
      accountIds?: number[];
    }
  ): Promise<FinapiAccountList> {
    return this.request<FinapiAccountList>("GET", "/api/v2/accounts", {
      token: userToken,
      params: {
        bankConnectionIds: options?.bankConnectionIds?.join(","),
        ids: options?.accountIds?.join(","),
        perPage: 500,
      },
    });
  }

  /**
   * Get single account
   */
  async getAccount(accountId: number, userToken: string): Promise<FinapiAccount> {
    return this.request<FinapiAccount>("GET", `/api/v2/accounts/${accountId}`, {
      token: userToken,
    });
  }

  // =========================================
  // TRANSACTIONS
  // =========================================

  /**
   * Get transactions
   */
  async getTransactions(
    userToken: string,
    options?: {
      accountIds?: number[];
      minBankBookingDate?: string;
      maxBankBookingDate?: string;
      page?: number;
      perPage?: number;
      direction?: "income" | "spending" | "all";
    }
  ): Promise<FinapiTransactionList> {
    return this.request<FinapiTransactionList>("GET", "/api/v2/transactions", {
      token: userToken,
      params: {
        accountIds: options?.accountIds?.join(","),
        minBankBookingDate: options?.minBankBookingDate,
        maxBankBookingDate: options?.maxBankBookingDate,
        page: options?.page || 1,
        perPage: options?.perPage || 500,
        direction: options?.direction || "all",
        view: "bankView",
      },
    });
  }

  /**
   * Get all transactions with pagination
   */
  async getAllTransactions(
    userToken: string,
    options?: {
      accountIds?: number[];
      minBankBookingDate?: string;
      maxBankBookingDate?: string;
    }
  ): Promise<FinapiTransaction[]> {
    const allTransactions: FinapiTransaction[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.getTransactions(userToken, {
        ...options,
        page,
        perPage: 500,
      });

      allTransactions.push(...response.transactions);
      hasMore = page < response.paging.totalPages;
      page++;
    }

    return allTransactions;
  }
}
