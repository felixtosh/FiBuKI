export const dynamic = "force-dynamic";

/**
 * Add accounts from an existing finAPI bank connection
 *
 * This endpoint is used when the user wants to add more accounts from a bank
 * they've already connected to finAPI (skipping the web form flow).
 *
 * Uses Cloud Functions for all Firestore operations.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { FinapiClient, FinapiEnvironment } from "@/lib/finapi/client";
import { callCloudFunction, callCloudFunctionBackground, setAuthToken } from "@/lib/firebase/callable-server";
import {
  CreateApiSourceRequest,
  CreateApiSourceResponse,
  SyncBankTransactionsRequest,
} from "@/types/banking-sync";

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

/**
 * POST /api/banking/finapi-accounts
 * Create a source from an existing finAPI bank connection
 */
export async function POST(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { bankConnectionId, accountId, name, syncFromYear } = body;

    if (!bankConnectionId || !accountId) {
      return NextResponse.json(
        { error: "bankConnectionId and accountId are required" },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // Get finAPI credentials from existing sources or bankingConnections
    let userAccessToken: string | null = null;
    let userRefreshToken: string | null = null;

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

    // Refresh the token
    let userToken = userAccessToken;
    try {
      const tokenResponse = await client.refreshUserToken(userRefreshToken);
      userToken = tokenResponse.access_token;
      userRefreshToken = tokenResponse.refresh_token || userRefreshToken;
    } catch (err) {
      console.warn("[finAPI Accounts] Token refresh failed, using existing:", err);
    }

    // Get account details from finAPI
    const accountIdNum = parseInt(accountId, 10);
    const accountsResponse = await client.getAccounts(userToken, {
      accountIds: [accountIdNum],
    });

    if (!accountsResponse.accounts || accountsResponse.accounts.length === 0) {
      return NextResponse.json(
        { error: "Account not found in finAPI" },
        { status: 404 }
      );
    }

    const account = accountsResponse.accounts[0];

    // Get bank connection details
    const bankConnection = await client.getBankConnection(bankConnectionId, userToken);
    const bankData = (bankConnection as unknown as { bank?: { id: number; name: string; logo?: { url: string } } }).bank;

    // Check if source already exists for this account
    const existingSourceQuery = await db
      .collection("sources")
      .where("userId", "==", userId)
      .where("apiConfig.accountId", "==", accountIdNum)
      .limit(1)
      .get();

    if (!existingSourceQuery.empty) {
      return NextResponse.json(
        { error: "This account is already connected", sourceId: existingSourceQuery.docs[0].id },
        { status: 409 }
      );
    }

    // Determine account kind
    const accountKind = account.accountType?.toLowerCase().includes("credit")
      ? "credit_card"
      : "bank_account";

    // Create the source via Cloud Function
    const sourceResult = await callCloudFunction<
      CreateApiSourceRequest,
      CreateApiSourceResponse
    >("createApiSource", {
      name: name || account.accountName || account.iban || `Account ${accountId}`,
      accountKind,
      iban: account.iban || null,
      currency: account.accountCurrency || "EUR",
      apiConfig: {
        provider: "finapi",
        bankConnectionId,
        accountId: accountIdNum,
        bankId: bankData?.id || bankConnection.bankId,
        institutionId: String(bankData?.id || bankConnection.bankId),
        institutionName: bankData?.name,
        institutionLogo: bankData?.logo?.url,
        userAccessToken: userToken,
        userRefreshToken,
        tokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        lastSyncAt: null,
      },
    });

    console.log(`[finAPI Accounts] Created source ${sanitizeForLog(sourceResult.sourceId)} for account ${sanitizeForLog(accountId)}`);

    // Trigger initial sync via Cloud Function in background
    if (syncFromYear) {
      callCloudFunctionBackground<SyncBankTransactionsRequest>(
        "syncBankTransactions",
        { sourceId: sourceResult.sourceId, fromYear: syncFromYear }
      );
    }

    return NextResponse.json({
      success: true,
      sourceId: sourceResult.sourceId,
      account: {
        id: account.id,
        iban: account.iban,
        name: account.accountName,
        type: account.accountType,
      },
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[finAPI Accounts] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create account" },
      { status: 500 }
    );
  }
}
