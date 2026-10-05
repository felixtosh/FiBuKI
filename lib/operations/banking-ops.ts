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
  Timestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import { getSourceById, updateSource } from "./source-ops";

import {
  getBankingProvider,
  getEnabledBankingProviders,
  BankingProviderId,
  BankingInstitution,
  BankingConnection,
  BankingAccount,
  BankingConfig,
  ConnectionStatus,
  ReauthRequiredError,
} from "@/lib/banking";
import { toDateSafe } from "@/lib/utils";

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

// =========================================
// SOURCE CREATION / LINKING
// =========================================

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
    lastSyncAt: toDateSafe(config.lastSyncAt) ?? undefined,
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
