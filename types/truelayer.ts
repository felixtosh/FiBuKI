import type { Timestamp } from "firebase/firestore";

/**
 * TrueLayer Data API types
 * https://docs.truelayer.com/
 */

/**
 * TrueLayer provider (bank)
 */
export interface TrueLayerProvider {
  provider_id: string;
  display_name: string;
  logo_uri?: string;
  logo_url?: string;
  country: string;
  scopes: string[];
}

/**
 * TrueLayer account types
 */
export type TrueLayerAccountType =
  | "TRANSACTION"
  | "SAVINGS"
  | "BUSINESS_TRANSACTION"
  | "BUSINESS_SAVINGS";

/**
 * TrueLayer account
 */
export interface TrueLayerAccount {
  account_id: string;
  account_type: TrueLayerAccountType;
  display_name: string;
  currency: string;
  account_number?: {
    iban?: string;
    swift_bic?: string;
    number?: string;
    sort_code?: string;
  };
  provider?: {
    provider_id: string;
    display_name: string;
    logo_uri: string;
  };
  update_timestamp: string;
}

/**
 * TrueLayer transaction
 */
export interface TrueLayerTransaction {
  transaction_id: string;
  timestamp: string;
  description: string;
  transaction_type: "CREDIT" | "DEBIT";
  transaction_category: string;
  transaction_classification: string[];
  amount: number;
  currency: string;
  merchant_name?: string;
  running_balance?: {
    amount: number;
    currency: string;
  };
  meta?: {
    provider_transaction_id?: string;
    provider_reference?: string;
  };
}

/**
 * TrueLayer connection stored in Firestore
 */
export interface TrueLayerConnection {
  id: string;
  /** Provider ID (bank identifier) */
  providerId: string;
  providerName: string;
  providerLogo?: string | null;
  /** Access token for API calls */
  accessToken: string;
  /** Refresh token */
  refreshToken: string;
  /** Token expiration */
  tokenExpiresAt: Timestamp;
  /** Account IDs linked */
  accountIds: string[];
  /** Owner */
  userId: string;
  /** Optional: source to link */
  linkToSourceId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * TrueLayer-specific API config stored on TransactionSource
 */
export interface TrueLayerApiConfig {
  provider: "truelayer";
  /** TrueLayer connection ID in our Firestore */
  connectionId: string;
  /** TrueLayer account ID */
  accountId: string;
  /** Provider info */
  providerId: string;
  providerName: string;
  providerLogo?: string;
  /** When the connection was created */
  connectedAt: Timestamp;
  /** Last successful sync */
  lastSyncAt?: Timestamp;
  /** Last sync error if any */
  lastSyncError?: string;
}

/**
 * TrueLayer token response
 */
export interface TrueLayerTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/**
 * TrueLayer API response wrapper
 */
export interface TrueLayerResponse<T> {
  results: T[];
  status: string;
}

/**
 * TrueLayer error response
 */
export interface TrueLayerErrorResponse {
  error: string;
  error_description?: string;
}
