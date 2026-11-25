/**
 * Types for banking sync operations
 *
 * These types mirror the Cloud Function types and are used
 * by API routes and frontend code.
 */

// ============================================================================
// Sync Transaction Types
// ============================================================================

export interface SyncBankTransactionsRequest {
  sourceId: string;
  fromYear?: number;
}

export interface SyncBankTransactionsResponse {
  success: boolean;
  imported: number;
  skipped: number;
  reassigned: number;
  total: number;
  importRecordId?: string;
  /** Rows before Tracked From (#794); not written. */
  untrackedCount?: number;
  /** The same rows per fiscal year (`2023`, or `2023/24`). */
  untrackedByFiscalYear?: Record<string, number>;
}

export interface CleanupOrphanedTransactionsRequest {
  dryRun?: boolean;
  targetUserId?: string; // Admin only
}

export interface CleanupOrphanedTransactionsResponse {
  dryRun: boolean;
  orphanedCount: number;
  orphanedBySource: Record<string, number>;
  deleted?: number;
}

// ============================================================================
// Banking Connection Types
// ============================================================================

export interface CreateBankingConnectionRequest {
  providerId: string;
  providerConnectionId: string;
  institutionId: string;
  institutionName: string;
  institutionLogo?: string | null;
  authUrl: string;
  expiresAt: string; // ISO date string
  providerData?: Record<string, unknown>;
  linkToSourceId?: string | null;
}

export interface CreateBankingConnectionResponse {
  success: boolean;
  connectionId: string;
  authUrl: string;
  expiresAt: string;
}

export interface UpdateBankingConnectionRequest {
  connectionId: string;
  updates: {
    status?: "pending" | "linked" | "rejected";
    statusMessage?: string | null;
    providerData?: Record<string, unknown>;
    linkedSourceId?: string | null;
  };
}

export interface UpdateBankingConnectionResponse {
  success: boolean;
}

export interface DeleteBankingConnectionRequest {
  connectionId: string;
}

export interface DeleteBankingConnectionResponse {
  success: boolean;
}

// ============================================================================
// API Source Types (for banking with apiConfig)
// ============================================================================

export interface ApiSourceConfig {
  provider: string;
  accountId: number | string;
  bankConnectionId?: number;
  bankId?: number;
  institutionId: string;
  institutionName?: string;
  institutionLogo?: string | null;
  userAccessToken?: string;
  userRefreshToken?: string;
  tokenExpiresAt?: string | Date | null;
  expiresAt?: string | Date | null; // PSD2 consent expiry
  syncFromYear?: number;
  lastSyncAt?: Date | null;
  finapiUserId?: string;
}

export interface CreateApiSourceRequest {
  name: string;
  accountKind: "bank_account" | "credit_card" | "checking" | "savings";
  iban?: string | null;
  currency: string;
  apiConfig: ApiSourceConfig;
  connectionId?: string; // Optional: link back to bankingConnection
}

export interface CreateApiSourceResponse {
  success: boolean;
  sourceId: string;
}

export interface UpdateSourceApiConfigRequest {
  sourceId: string;
  apiConfig: Partial<ApiSourceConfig>;
}

export interface UpdateSourceApiConfigResponse {
  success: boolean;
}
