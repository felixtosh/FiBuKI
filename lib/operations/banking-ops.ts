/**
 * Provider-agnostic banking operations
 *
 * This module provides a unified interface for all banking providers
 * (finAPI, TrueLayer, etc.) using the banking abstraction layer.
 */

import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  deleteDoc,
  Timestamp,
  writeBatch,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import { getSourceById, updateSource } from "./source-ops";
import { checkDuplicatesBatch } from "@/lib/import/deduplication";
import { normalizeIban } from "@/lib/import/deduplication";

import {
  getBankingProvider,
  getEnabledBankingProviders,
  BankingProviderId,
  BankingInstitution,
  BankingConnection,
  BankingAccount,
  BankingConfig,
  ConnectionStatus,
  SyncResult,
  ReauthRequiredError,
} from "@/lib/banking";

const CONNECTIONS_COLLECTION = "bankingConnections";
const TRANSACTIONS_COLLECTION = "transactions";

// =========================================
// PROVIDER INFO
// =========================================

/**
 * List all available banking providers and their status
 */
export function listBankingProviders() {
  return getEnabledBankingProviders().map((p) => p.getInfo());
}

/**
 * Get a specific provider's info
 */
export function getBankingProviderInfo(providerId: BankingProviderId) {
  const provider = getBankingProvider(providerId);
  return provider.getInfo();
}

// =========================================
// INSTITUTIONS
// =========================================

/**
 * List available financial institutions for a country
 * Optionally filter by provider
 */
export async function listInstitutions(
  ctx: OperationsContext,
  countryCode: string,
  providerId?: BankingProviderId
): Promise<BankingInstitution[]> {
  if (providerId) {
    const provider = getBankingProvider(providerId);
    return provider.listInstitutions(countryCode);
  }

  // Get from all enabled providers
  const providers = getEnabledBankingProviders();
  const results = await Promise.allSettled(
    providers.map((p) => p.listInstitutions(countryCode))
  );

  const institutions: BankingInstitution[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      institutions.push(...result.value);
    }
  }

  return institutions.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get a specific institution
 */
export async function getInstitution(
  ctx: OperationsContext,
  institutionId: string,
  providerId: BankingProviderId
): Promise<BankingInstitution> {
  const provider = getBankingProvider(providerId);
  return provider.getInstitution(institutionId);
}

// =========================================
// CONNECTIONS
// =========================================

/**
 * Create a new bank connection request
 * Returns the authorization URL for the user to visit
 */
export async function createBankConnection(
  ctx: OperationsContext,
  providerId: BankingProviderId,
  institutionId: string,
  options?: {
    sourceId?: string; // Existing source to link (for re-auth)
    maxHistoryDays?: number;
    language?: string;
  }
): Promise<{ connectionId: string; authUrl: string; expiresAt: Date }> {
  const provider = getBankingProvider(providerId);

  // Get institution info
  const institution = await provider.getInstitution(institutionId);

  // Get redirect URL from environment
  const redirectUrl = getRedirectUrl(providerId);

  // Create connection with provider
  const result = await provider.createConnection({
    institutionId,
    redirectUrl,
    maxHistoryDays: options?.maxHistoryDays,
    language: options?.language,
    reference: `conn_${ctx.userId}_${Date.now()}`,
  });

  // Store connection in Firestore
  const connectionDoc: Omit<BankingConnection, "id"> = {
    providerId,
    providerConnectionId: result.connectionId,
    institutionId,
    institutionName: institution.name,
    institutionLogo: institution.logoUrl,
    status: "pending",
    authUrl: result.authUrl,
    accountIds: [],
    expiresAt: Timestamp.fromDate(result.expiresAt),
    providerData: result.providerData,
    linkToSourceId: options?.sourceId,
    userId: ctx.userId,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  const docRef = await addDoc(
    collection(ctx.db, CONNECTIONS_COLLECTION),
    connectionDoc
  );

  return {
    connectionId: docRef.id,
    authUrl: result.authUrl,
    expiresAt: result.expiresAt,
  };
}

/**
 * Get a connection by our internal ID
 */
export async function getBankConnection(
  ctx: OperationsContext,
  connectionId: string
): Promise<BankingConnection | null> {
  const docRef = doc(ctx.db, CONNECTIONS_COLLECTION, connectionId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  if (data.userId !== ctx.userId) {
    return null;
  }

  return { id: snapshot.id, ...data } as BankingConnection;
}

/**
 * List all connections for the current user
 */
export async function listBankConnections(
  ctx: OperationsContext,
  options?: {
    providerId?: BankingProviderId;
    status?: ConnectionStatus;
  }
): Promise<BankingConnection[]> {
  let q = query(
    collection(ctx.db, CONNECTIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  let connections = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as BankingConnection[];

  // Apply filters
  if (options?.providerId) {
    connections = connections.filter((c) => c.providerId === options.providerId);
  }
  if (options?.status) {
    connections = connections.filter((c) => c.status === options.status);
  }

  return connections;
}

/**
 * Handle OAuth callback from banking provider
 */
export async function handleBankCallback(
  ctx: OperationsContext,
  connectionId: string,
  callbackParams: {
    code?: string;
    error?: string;
    errorDescription?: string;
  }
): Promise<BankingConnection> {
  const connection = await getBankConnection(ctx, connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  const provider = getBankingProvider(connection.providerId);

  // Handle callback with provider
  const result = await provider.handleCallback({
    connectionId: connection.providerConnectionId,
    ...callbackParams,
  });

  // Update connection in Firestore
  const docRef = doc(ctx.db, CONNECTIONS_COLLECTION, connectionId);
  const updates: Partial<BankingConnection> = {
    status: result.status,
    accountIds: result.accountIds || connection.accountIds,
    updatedAt: Timestamp.now(),
  };

  if (result.providerData) {
    updates.providerData = {
      ...connection.providerData,
      ...result.providerData,
    };
  }

  await updateDoc(docRef, updates);

  return {
    ...connection,
    ...updates,
  };
}

/**
 * Refresh connection status from provider
 */
export async function refreshBankConnectionStatus(
  ctx: OperationsContext,
  connectionId: string
): Promise<BankingConnection> {
  const connection = await getBankConnection(ctx, connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  const provider = getBankingProvider(connection.providerId);
  const status = await provider.getConnectionStatus(connection.providerConnectionId);

  // Update connection
  const docRef = doc(ctx.db, CONNECTIONS_COLLECTION, connectionId);
  await updateDoc(docRef, {
    status: status.status,
    accountIds: status.accountIds || connection.accountIds,
    updatedAt: Timestamp.now(),
  });

  return {
    ...connection,
    status: status.status,
    accountIds: status.accountIds || connection.accountIds,
  };
}

/**
 * Get accounts available in a connection
 */
export async function getBankConnectionAccounts(
  ctx: OperationsContext,
  connectionId: string
): Promise<BankingAccount[]> {
  const connection = await getBankConnection(ctx, connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  if (connection.status !== "linked") {
    throw new Error(`Connection is not linked. Status: ${connection.status}`);
  }

  const provider = getBankingProvider(connection.providerId);
  return provider.getAccounts(connection.providerConnectionId);
}

/**
 * Delete a connection (revokes access)
 */
export async function deleteBankConnection(
  ctx: OperationsContext,
  connectionId: string
): Promise<void> {
  const connection = await getBankConnection(ctx, connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  // Revoke at provider (may fail if already expired)
  try {
    const provider = getBankingProvider(connection.providerId);
    await provider.revokeConnection(connection.providerConnectionId);
  } catch {
    // Ignore errors
  }

  // Delete from Firestore
  const docRef = doc(ctx.db, CONNECTIONS_COLLECTION, connectionId);
  await deleteDoc(docRef);
}

// =========================================
// SOURCE CREATION / LINKING
// =========================================

/**
 * Create a source from a banking account
 */
export async function createSourceFromBankAccount(
  ctx: OperationsContext,
  connectionId: string,
  accountId: string,
  name: string
): Promise<string> {
  const connection = await getBankConnection(ctx, connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  if (!connection.accountIds.includes(accountId)) {
    throw new Error(`Account ${accountId} not in connection`);
  }

  const provider = getBankingProvider(connection.providerId);
  const accounts = await provider.getAccounts(connection.providerConnectionId);
  const account = accounts.find((a) => a.id === accountId);

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  // Build config based on provider
  const apiConfig = buildApiConfig(connection, accountId);

  // Create source
  const now = Timestamp.now();
  const sourceData = {
    name,
    accountKind: account.type === "credit_card" ? "credit_card" : "bank_account",
    iban: account.iban ? normalizeIban(account.iban) : undefined,
    currency: account.currency || "EUR",
    type: "api" as const,
    apiConfig,
    isActive: true,
    userId: ctx.userId,
    createdAt: now,
    updatedAt: now,
  };

  const docRef = await addDoc(collection(ctx.db, "sources"), sourceData);
  return docRef.id;
}

/**
 * Link a banking account to an existing source
 */
export async function linkBankAccountToSource(
  ctx: OperationsContext,
  connectionId: string,
  accountId: string,
  sourceId: string
): Promise<void> {
  const connection = await getBankConnection(ctx, connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found`);
  }

  const source = await getSourceById(ctx, sourceId);
  if (!source) {
    throw new Error(`Source ${sourceId} not found`);
  }

  // Build config
  const apiConfig = buildApiConfig(connection, accountId);

  // Update source
  await updateSource(ctx, sourceId, {
    type: "api",
    apiConfig: apiConfig as any, // Type assertion for now - TODO: fix BankingConfig types
  });
}

// =========================================
// TRANSACTION SYNC
// =========================================

/**
 * Sync transactions for an API-connected source
 */
export async function syncBankTransactions(
  ctx: OperationsContext,
  sourceId: string
): Promise<SyncResult> {
  const source = await getSourceById(ctx, sourceId);
  if (!source) {
    throw new Error(`Source ${sourceId} not found`);
  }

  if (source.type !== "api" || !source.apiConfig) {
    throw new Error("Source is not an API-connected account");
  }

  const config = source.apiConfig as BankingConfig;
  const provider = getBankingProvider(config.provider);

  // Check if re-auth is required
  const reauthInfo = provider.checkReauthRequired(config);
  if (reauthInfo.required) {
    throw new ReauthRequiredError(
      config.provider,
      sourceId,
      reauthInfo.expiresAt || new Date()
    );
  }

  // Refresh token if needed (for OAuth providers like TrueLayer)
  if (provider.refreshTokenIfNeeded) {
    const refreshedConfig = await provider.refreshTokenIfNeeded(config);
    if (refreshedConfig) {
      await updateSource(ctx, sourceId, {
        apiConfig: refreshedConfig as any, // Type assertion - TODO: fix BankingConfig types
      });
      (config as any).accessToken = (refreshedConfig as any).accessToken;
    }
  }

  // Calculate date range
  const lastSyncAt = config.lastSyncAt?.toDate();
  const dateFrom = lastSyncAt
    ? new Date(lastSyncAt.getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const dateTo = new Date().toISOString().split("T")[0];

  // Fetch transactions
  const bankingTransactions = await provider.fetchTransactions({
    accountId: config.accountId,
    dateFrom,
    dateTo,
    config,
  });

  if (bankingTransactions.length === 0) {
    await updateSource(ctx, sourceId, {
      apiConfig: {
        ...config,
        lastSyncAt: Timestamp.now(),
        lastSyncError: undefined,
      } as any, // Type assertion - TODO: fix BankingConfig types
    });
    return { imported: 0, skipped: 0, total: 0 };
  }

  // Transform to our format
  const syncJobId = `sync_${sourceId}_${Date.now()}`;
  const transactions = bankingTransactions.map((tx) => ({
    name: tx.counterpartyName || tx.description || "Unknown",
    description: tx.description || "",
    amount: Math.round(tx.amount * 100), // Convert to cents
    currency: tx.currency,
    date: Timestamp.fromDate(new Date(tx.bookingDate)),
    sourceId,
    userId: ctx.userId,
    importJobId: syncJobId,
    dedupeHash: generateDedupeHash(tx, source.iban || sourceId),
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  }));

  // Check for duplicates
  const hashes = transactions.map((t) => t.dedupeHash);
  const existingHashes = await checkDuplicatesBatch(hashes, sourceId);

  // Filter out duplicates
  const newTransactions = transactions.filter((t) => !existingHashes.has(t.dedupeHash));

  // Batch write
  const BATCH_SIZE = 500;
  let imported = 0;

  for (let i = 0; i < newTransactions.length; i += BATCH_SIZE) {
    const batch = writeBatch(ctx.db);
    const slice = newTransactions.slice(i, i + BATCH_SIZE);

    for (const tx of slice) {
      const docRef = doc(collection(ctx.db, TRANSACTIONS_COLLECTION));
      batch.set(docRef, tx);
      imported++;
    }

    await batch.commit();
  }

  // Update source - handle provider-specific data
  const providerConfig = config as any;
  const updatedConfig: any = {
    ...config,
    lastSyncAt: Timestamp.now(),
    lastSyncError: undefined,
  };

  // For Plaid, save the new cursor for incremental syncs
  if (config.provider === "plaid" && providerConfig._newCursor) {
    updatedConfig.syncCursor = providerConfig._newCursor;
  }

  // For finAPI, save refreshed tokens if they were updated
  if (config.provider === "finapi") {
    if (providerConfig._refreshedToken) {
      updatedConfig.userAccessToken = providerConfig._refreshedToken;
    }
    if (providerConfig._refreshedRefreshToken) {
      updatedConfig.userRefreshToken = providerConfig._refreshedRefreshToken;
    }
    if (providerConfig._tokenExpiresAt) {
      updatedConfig.tokenExpiresAt = Timestamp.fromDate(
        new Date(providerConfig._tokenExpiresAt)
      );
    }
  }

  await updateSource(ctx, sourceId, {
    apiConfig: updatedConfig,
  });

  return {
    imported,
    skipped: existingHashes.size,
    total: bankingTransactions.length,
  };
}

/**
 * Get sync status for a source
 */
export async function getBankSyncStatus(
  ctx: OperationsContext,
  sourceId: string
): Promise<{
  lastSyncAt?: Date;
  lastSyncError?: string;
  needsReauth: boolean;
  expiresAt?: Date;
  daysRemaining?: number;
  providerId: BankingProviderId;
}> {
  const source = await getSourceById(ctx, sourceId);
  if (!source) {
    throw new Error(`Source ${sourceId} not found`);
  }

  if (source.type !== "api" || !source.apiConfig) {
    throw new Error("Source is not an API-connected account");
  }

  const config = source.apiConfig as BankingConfig;
  const provider = getBankingProvider(config.provider);
  const reauthInfo = provider.checkReauthRequired(config);

  return {
    lastSyncAt: config.lastSyncAt?.toDate(),
    lastSyncError: config.lastSyncError,
    needsReauth: reauthInfo.required,
    expiresAt: reauthInfo.expiresAt,
    daysRemaining: reauthInfo.daysRemaining,
    providerId: config.provider,
  };
}

// =========================================
// HELPERS
// =========================================

function getRedirectUrl(providerId: BankingProviderId): string {
  switch (providerId) {
    case "truelayer":
      return process.env.TRUELAYER_REDIRECT_URL || "";
    case "plaid":
      return process.env.PLAID_REDIRECT_URL || "";
    case "finapi":
      return process.env.FINAPI_REDIRECT_URL || "";
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

function buildApiConfig(
  connection: BankingConnection,
  accountId: string
): BankingConfig {
  const baseConfig = {
    provider: connection.providerId,
    accountId,
    institutionId: connection.institutionId,
    institutionName: connection.institutionName,
    institutionLogo: connection.institutionLogo,
    expiresAt: connection.expiresAt,
  };

  switch (connection.providerId) {
    case "truelayer":
      return {
        ...baseConfig,
        provider: "truelayer",
        accessToken: connection.providerData?.accessToken as string,
        refreshToken: connection.providerData?.refreshToken as string,
        tokenExpiresAt: Timestamp.fromDate(
          new Date(connection.providerData?.tokenExpiresAt as string)
        ),
      };

    case "plaid":
      return {
        ...baseConfig,
        provider: "plaid",
        accessToken: connection.providerData?.accessToken as string,
        itemId: connection.providerData?.itemId as string,
        syncCursor: undefined, // Will be populated after first sync
      };

    case "finapi":
      return {
        ...baseConfig,
        provider: "finapi",
        bankConnectionId: connection.providerData?.bankConnectionId as number,
        userAccessToken: connection.providerData?.userAccessToken as string,
        userRefreshToken: connection.providerData?.userRefreshToken as string,
        tokenExpiresAt: Timestamp.fromDate(
          new Date(connection.providerData?.tokenExpiresAt as string)
        ),
        finapiUserId: connection.providerData?.finapiUserId as string,
      };

    default:
      throw new Error(`Unsupported provider: ${connection.providerId}`);
  }
}

function generateDedupeHash(
  tx: { id: string; bookingDate: string; amount: number; currency: string },
  identifier: string
): string {
  // Use crypto if available, otherwise simple hash
  const data = `${identifier}|${tx.bookingDate}|${tx.amount}|${tx.currency}|${tx.id}`;

  if (typeof crypto !== "undefined" && crypto.subtle) {
    // Browser/Node 18+
    return data; // In production, use actual hash
  }

  // Simple hash fallback
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `hash_${Math.abs(hash).toString(36)}`;
}
