export const dynamic = "force-dynamic";

/**
 * finAPI Bank Connections API
 *
 * Fetches all bank connections from finAPI for the current user
 * and identifies orphaned connections (exist in finAPI but not in our sources).
 *
 * This helps users clean up connections that were deleted from our app
 * but still exist in finAPI (causing "already connected" errors).
 *
 * Uses Cloud Functions for all Firestore writes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { FinapiClient, FinapiEnvironment } from "@/lib/finapi/client";
import { callCloudFunction, setAuthToken } from "@/lib/firebase/callable-server";
import {
  UpdateSourceApiConfigRequest,
  UpdateSourceApiConfigResponse,
  DeleteBankingConnectionRequest,
  DeleteBankingConnectionResponse,
} from "@/types/banking-sync";

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

interface FinapiAccountInfo {
  accountId: number;
  iban?: string;
  ownerName?: string;
  accountType?: string;
  accountName?: string;
}

interface FinapiConnectionInfo {
  bankConnectionId: number;
  bankId: number;
  bankName?: string;
  bankLogo?: string;
  accountIds: number[];
  accounts: FinapiAccountInfo[];
  updateStatus: string;
}

/**
 * GET /api/banking/finapi-connections
 * Fetches all finAPI connections and identifies orphaned ones
 */
export async function GET(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = getAdminDb();

    // Get all finAPI sources for this user
    const sourcesQuery = await db
      .collection("sources")
      .where("userId", "==", userId)
      .where("type", "==", "api")
      .get();

    const finapiSources = sourcesQuery.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((s: Record<string, unknown>) => (s.apiConfig as Record<string, unknown>)?.provider === "finapi");

    // Try to get credentials from sources first, then from bankingConnections
    let userAccessToken: string | null = null;
    let userRefreshToken: string | null = null;
    let credentialSourceId: string | null = null;

    // Check sources for credentials
    for (const source of finapiSources) {
      const sourceConfig = (source as Record<string, unknown>).apiConfig as Record<string, unknown>;
      if (sourceConfig?.userAccessToken && sourceConfig?.userRefreshToken) {
        userAccessToken = sourceConfig.userAccessToken as string;
        userRefreshToken = sourceConfig.userRefreshToken as string;
        credentialSourceId = (source as Record<string, unknown>).id as string;
        break;
      }
    }

    // If no credentials from sources, check bankingConnections (for cases where sources were deleted)
    if (!userAccessToken || !userRefreshToken) {
      console.log("[finAPI Connections] No credentials from sources, checking bankingConnections...");
      try {
        const connectionsQuery = await db
          .collection("bankingConnections")
          .where("userId", "==", userId)
          .where("providerId", "==", "finapi")
          .get();

        console.log(`[finAPI Connections] Found ${connectionsQuery.docs.length} banking connections`);

        for (const doc of connectionsQuery.docs) {
          const connData = doc.data();
          const providerData = connData.providerData as Record<string, unknown> | undefined;
          console.log(`[finAPI Connections] Connection ${doc.id} has providerData:`, !!providerData?.userAccessToken);
          if (providerData?.userAccessToken && providerData?.userRefreshToken) {
            userAccessToken = providerData.userAccessToken as string;
            userRefreshToken = providerData.userRefreshToken as string;
            break;
          }
        }
      } catch (err) {
        console.error("[finAPI Connections] Error querying bankingConnections:", err);
      }
    }

    // If still no credentials, user has never connected to finAPI
    if (!userAccessToken || !userRefreshToken) {
      console.log("[finAPI Connections] No credentials found anywhere");
      return NextResponse.json({
        orphanedConnections: [],
        linkedConnections: [],
        message: "No finAPI credentials found",
      });
    }

    console.log("[finAPI Connections] Found credentials, credential source:", credentialSourceId || "bankingConnections");

    // Initialize finAPI client
    const clientId = process.env.FINAPI_CLIENT_ID;
    const clientSecret = process.env.FINAPI_CLIENT_SECRET;
    const environment = (process.env.FINAPI_ENVIRONMENT || "sandbox") as FinapiEnvironment;

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: "finAPI is not configured" },
        { status: 500 }
      );
    }

    const client = new FinapiClient({ clientId, clientSecret, environment });

    // Always try to refresh the token since we don't track expiry reliably across sources/connections
    let userToken = userAccessToken;
    let tokenRefreshFailed = false;
    console.log("[finAPI Connections] Refreshing token...");
    try {
      const tokenResponse = await client.refreshUserToken(userRefreshToken);
      userToken = tokenResponse.access_token;

      // Update tokens in the source we used (if we have one) via callable
      if (credentialSourceId) {
        await callCloudFunction<
          UpdateSourceApiConfigRequest,
          UpdateSourceApiConfigResponse
        >("updateSourceApiConfig", {
          sourceId: credentialSourceId,
          apiConfig: {
            userAccessToken: userToken,
            userRefreshToken: tokenResponse.refresh_token || userRefreshToken,
            tokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
          },
        });
      }
    } catch (err) {
      console.error("[finAPI Connections] Failed to refresh token, trying with existing token:", err);
      tokenRefreshFailed = true;
      // Try with the existing token anyway - it might still be valid
    }

    // Fetch all bank connections from finAPI
    let finapiConnections;
    try {
      finapiConnections = await client.getBankConnections(userToken);
      console.log(`[finAPI Connections] Raw response:`, JSON.stringify(finapiConnections, null, 2));
    } catch (err) {
      console.error("[finAPI Connections] Failed to fetch connections:", err);

      // Fallback: Build connections from local sources when finAPI is unavailable
      // This allows users to still see their connected banks even with expired tokens
      const linkedFromSources: FinapiConnectionInfo[] = [];
      const seenBankConnectionIds = new Set<number>();

      for (const source of finapiSources) {
        const sourceConfig = (source as Record<string, unknown>).apiConfig as Record<string, unknown>;
        const bankConnectionId = sourceConfig?.bankConnectionId as number | undefined;

        if (bankConnectionId && !seenBankConnectionIds.has(bankConnectionId)) {
          seenBankConnectionIds.add(bankConnectionId);
          linkedFromSources.push({
            bankConnectionId,
            bankId: sourceConfig?.bankId as number || 0,
            bankName: sourceConfig?.institutionName as string || "Unknown Bank",
            bankLogo: sourceConfig?.institutionLogo as string,
            accountIds: [], // We don't know the full list without finAPI
            accounts: [], // Can't fetch account details without valid token
            updateStatus: "READY",
          });
        }
      }

      console.log(`[finAPI Connections] Fallback: Found ${linkedFromSources.length} connections from local sources`);

      return NextResponse.json({
        orphanedConnections: [],
        linkedConnections: linkedFromSources,
        error: "Token expired - showing cached connections. Re-authenticate to refresh.",
        tokenExpired: true,
      });
    }

    console.log(`[finAPI Connections] Found ${finapiConnections.connections.length} connections in finAPI`);

    // Get bank connection IDs that are linked to our sources
    const linkedBankConnectionIds = new Set<number>();
    for (const source of finapiSources) {
      const sourceConfig = (source as Record<string, unknown>).apiConfig as Record<string, unknown>;
      const bankConnectionId = sourceConfig?.bankConnectionId as number | undefined;
      if (bankConnectionId) {
        linkedBankConnectionIds.add(bankConnectionId);
      }
    }

    // Identify orphaned connections
    const orphanedConnections: FinapiConnectionInfo[] = [];
    const linkedConnections: FinapiConnectionInfo[] = [];

    // Fetch all accounts for the user (we'll group them by connection)
    let allAccounts: Array<{
      id: number;
      iban?: string;
      accountHolderName?: string;
      accountName?: string;
      accountType?: string;
      bankConnectionId?: number;
    }> = [];
    try {
      const accountsResponse = await client.getAccounts(userToken, {});
      allAccounts = accountsResponse.accounts || [];
      console.log(`[finAPI Connections] Fetched ${allAccounts.length} total accounts`);
    } catch (err) {
      console.warn("[finAPI Connections] Failed to fetch accounts:", err);
    }

    // Create a map of bankConnectionId -> accounts
    const accountsByConnection = new Map<number, typeof allAccounts>();
    for (const account of allAccounts) {
      const connId = account.bankConnectionId;
      if (connId) {
        const existing = accountsByConnection.get(connId) || [];
        accountsByConnection.set(connId, [...existing, account]);
      }
    }

    // Fetch bank details for each connection
    // Note: finAPI v2 returns bank info nested under `bank` object, not as `bankId`
    for (const conn of finapiConnections.connections) {
      // Access the nested bank object (finAPI v2 structure)
      const bankData = (conn as unknown as { bank?: { id: number; name: string; logo?: { url: string } } }).bank;
      const bankId = bankData?.id || conn.bankId;
      const bankName = bankData?.name;
      const bankLogo = bankData?.logo?.url;

      // Get full account details for this connection
      const connectionAccounts = accountsByConnection.get(conn.id) || [];

      console.log(`[finAPI Connections] Processing connection:`, {
        id: conn.id,
        bankId,
        bankName,
        accountIds: conn.accountIds,
        accountCount: connectionAccounts.length,
      });

      const connectionInfo: FinapiConnectionInfo = {
        bankConnectionId: conn.id,
        bankId: bankId,
        bankName: bankName || `Bank ${bankId || "Unknown"}`,
        bankLogo,
        accountIds: conn.accountIds || [],
        accounts: connectionAccounts.map(a => ({
          accountId: a.id,
          iban: a.iban,
          ownerName: a.accountHolderName || a.accountName,
          accountType: a.accountType,
          accountName: a.accountName,
        })),
        updateStatus: conn.updateStatus,
      };

      if (linkedBankConnectionIds.has(conn.id)) {
        linkedConnections.push(connectionInfo);
      } else {
        orphanedConnections.push(connectionInfo);
      }
    }

    console.log(`[finAPI Connections] ${orphanedConnections.length} orphaned, ${linkedConnections.length} linked`);

    return NextResponse.json({
      orphanedConnections,
      linkedConnections,
      // If token refresh failed, the user needs to re-authenticate to add new accounts
      tokenExpired: tokenRefreshFailed,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[finAPI Connections] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch connections" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/banking/finapi-connections
 * Delete an orphaned connection from finAPI
 */
export async function DELETE(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { bankConnectionId } = body;

    // finAPI connection ids are numeric — reject anything else so the value
    // can't smuggle path segments into the finAPI request URL
    if (typeof bankConnectionId !== "number" || !Number.isInteger(bankConnectionId)) {
      return NextResponse.json(
        { error: "bankConnectionId is required" },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // Try to get credentials from sources first, then from bankingConnections
    let userAccessToken: string | null = null;
    let userRefreshToken: string | null = null;
    let credentialSourceId: string | null = null;

    // Check sources for credentials
    const sourcesQuery = await db
      .collection("sources")
      .where("userId", "==", userId)
      .where("type", "==", "api")
      .limit(10)
      .get();

    for (const doc of sourcesQuery.docs) {
      const data = doc.data();
      const apiConfig = data.apiConfig as Record<string, unknown> | undefined;
      if (apiConfig?.provider === "finapi" && apiConfig?.userAccessToken && apiConfig?.userRefreshToken) {
        userAccessToken = apiConfig.userAccessToken as string;
        userRefreshToken = apiConfig.userRefreshToken as string;
        credentialSourceId = doc.id;
        break;
      }
    }

    // If no credentials from sources, check bankingConnections
    if (!userAccessToken || !userRefreshToken) {
      const connectionsQuery = await db
        .collection("bankingConnections")
        .where("userId", "==", userId)
        .where("providerId", "==", "finapi")
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();

      for (const doc of connectionsQuery.docs) {
        const connData = doc.data();
        const providerData = connData.providerData as Record<string, unknown> | undefined;
        if (providerData?.userAccessToken && providerData?.userRefreshToken) {
          userAccessToken = providerData.userAccessToken as string;
          userRefreshToken = providerData.userRefreshToken as string;
          break;
        }
      }
    }

    if (!userAccessToken || !userRefreshToken) {
      return NextResponse.json(
        { error: "No finAPI credentials found" },
        { status: 400 }
      );
    }

    // Initialize finAPI client
    const clientId = process.env.FINAPI_CLIENT_ID;
    const clientSecret = process.env.FINAPI_CLIENT_SECRET;
    const environment = (process.env.FINAPI_ENVIRONMENT || "sandbox") as FinapiEnvironment;

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: "finAPI is not configured" },
        { status: 500 }
      );
    }

    const client = new FinapiClient({ clientId, clientSecret, environment });

    // Always try to refresh the token
    let userToken = userAccessToken;
    try {
      const tokenResponse = await client.refreshUserToken(userRefreshToken);
      userToken = tokenResponse.access_token;

      // Update tokens in source via callable if we have one
      if (credentialSourceId) {
        await callCloudFunction<
          UpdateSourceApiConfigRequest,
          UpdateSourceApiConfigResponse
        >("updateSourceApiConfig", {
          sourceId: credentialSourceId,
          apiConfig: {
            userAccessToken: userToken,
            userRefreshToken: tokenResponse.refresh_token || userRefreshToken,
            tokenExpiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString(),
          },
        });
      }
    } catch (err) {
      console.error("[finAPI Connections] Failed to refresh token, trying with existing:", err);
      // Continue with existing token
    }

    // Delete the connection from finAPI
    try {
      await client.deleteBankConnection(bankConnectionId, userToken);
      console.log(`[finAPI Connections] Deleted bank connection ${sanitizeForLog(bankConnectionId)}`);
    } catch (err) {
      console.error("[finAPI Connections] Failed to delete connection %s:", sanitizeForLog(bankConnectionId), sanitizeForLog(err));
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to delete connection from finAPI" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[finAPI Connections] Delete error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete connection" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/banking/finapi-connections
 * Reset finAPI user (delete and recreate) - use when finAPI is in an inconsistent state
 */
export async function PATCH(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action } = body;

    if (action !== "reset-finapi-user") {
      return NextResponse.json(
        { error: "Invalid action" },
        { status: 400 }
      );
    }

    // Initialize finAPI client
    const clientId = process.env.FINAPI_CLIENT_ID;
    const clientSecret = process.env.FINAPI_CLIENT_SECRET;
    const environment = (process.env.FINAPI_ENVIRONMENT || "sandbox") as FinapiEnvironment;

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: "finAPI is not configured" },
        { status: 500 }
      );
    }

    const client = new FinapiClient({ clientId, clientSecret, environment });

    // The finAPI user ID is based on our Firebase user ID
    const finapiUserId = `fb_${userId}`;

    console.log(`[finAPI Connections] Deleting finAPI user: ${sanitizeForLog(finapiUserId)}`);

    try {
      await client.deleteUser(finapiUserId);
      console.log(`[finAPI Connections] Successfully deleted finAPI user: ${sanitizeForLog(finapiUserId)}`);
    } catch (err) {
      // User might not exist, that's OK
      console.warn(`[finAPI Connections] Failed to delete finAPI user (might not exist):`, sanitizeForLog(err));
    }

    // Clean up any bankingConnections for this user via callable
    const db = getAdminDb();
    const connectionsQuery = await db
      .collection("bankingConnections")
      .where("userId", "==", userId)
      .where("providerId", "==", "finapi")
      .get();

    for (const doc of connectionsQuery.docs) {
      await callCloudFunction<
        DeleteBankingConnectionRequest,
        DeleteBankingConnectionResponse
      >("deleteBankingConnection", {
        connectionId: doc.id,
      });
    }
    console.log(`[finAPI Connections] Deleted ${connectionsQuery.docs.length} banking connections`);

    return NextResponse.json({
      success: true,
      message: "finAPI user reset. You can now connect your bank fresh."
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[finAPI Connections] Reset error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reset finAPI user" },
      { status: 500 }
    );
  }
}
