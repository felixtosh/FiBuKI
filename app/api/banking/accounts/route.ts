export const dynamic = "force-dynamic";

/**
 * Create Source from Banking Account
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
  UpdateBankingConnectionRequest,
  UpdateBankingConnectionResponse,
  SyncBankTransactionsRequest,
  SyncBankTransactionsResponse,
} from "@/types/banking-sync";

export async function POST(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { connectionId, accountId, name, sourceId, syncFromYear } = body;

    // Default to current year if not provided
    const effectiveSyncYear = syncFromYear || new Date().getFullYear();

    if (!connectionId || !accountId || !name) {
      return NextResponse.json(
        { error: "connectionId, accountId, and name are required" },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // Get connection (read only - for verification and provider data)
    const connectionDoc = await db
      .collection("bankingConnections")
      .doc(connectionId)
      .get();

    if (!connectionDoc.exists) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    const connection = connectionDoc.data();

    // Verify ownership
    if (connection?.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (connection.status !== "linked") {
      return NextResponse.json(
        { error: "Connection is not linked" },
        { status: 400 }
      );
    }

    // Get account details from finAPI (external read)
    let accountDetails: {
      iban?: string;
      currency: string;
      type: string;
    } = {
      currency: "EUR",
      type: "Checking",
    };

    if (connection.providerId === "finapi") {
      const clientId = process.env.FINAPI_CLIENT_ID;
      const clientSecret = process.env.FINAPI_CLIENT_SECRET;
      const environment = (process.env.FINAPI_ENVIRONMENT ||
        "sandbox") as FinapiEnvironment;

      if (clientId && clientSecret && connection.providerData?.userAccessToken) {
        const client = new FinapiClient({
          clientId,
          clientSecret,
          environment,
        });

        try {
          const account = await client.getAccount(
            parseInt(accountId, 10),
            connection.providerData.userAccessToken as string
          );
          accountDetails = {
            iban: account.iban,
            currency: account.accountCurrency || "EUR",
            type: account.accountType,
          };
        } catch (err) {
          console.error("[Banking Accounts] Error fetching account:", err);
        }
      }
    }

    // PSD2 consent is valid for 90 days
    const psd2ExpiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    // Build API config for the source
    const apiConfig = {
      provider: connection.providerId,
      accountId,
      institutionId: connection.institutionId,
      institutionName: connection.institutionName,
      institutionLogo: connection.institutionLogo || null,
      expiresAt: psd2ExpiresAt.toISOString(),
      syncFromYear: effectiveSyncYear,
      // finAPI specific
      bankConnectionId: connection.providerData?.bankConnectionId,
      userAccessToken: connection.providerData?.userAccessToken,
      userRefreshToken: connection.providerData?.userRefreshToken,
      tokenExpiresAt: connection.providerData?.tokenExpiresAt || null,
      finapiUserId: connection.providerData?.finapiUserId,
    };

    let resultSourceId: string;

    if (sourceId) {
      // Update existing source via callable
      await callCloudFunction("updateSourceApiConfig", {
        sourceId,
        apiConfig: {
          ...apiConfig,
          // Also update name if provided
        },
      });
      // Also update name if it changed - use existing updateSource callable
      await callCloudFunction("updateSource", {
        sourceId,
        data: {
          name,
          iban: accountDetails.iban || null,
          currency: accountDetails.currency,
        },
      });
      resultSourceId = sourceId;
    } else {
      // Map finAPI account types to our accountKind
      // finAPI types: Checking, Savings, CreditCard, Security, Membership, Loan, Bausparen, Insurance, Unknown
      const accountKind = ["CreditCard", "Credit Card"].includes(accountDetails.type)
        ? "credit_card"
        : "bank_account";

      // Create new source via Cloud Function
      const result = await callCloudFunction<
        CreateApiSourceRequest,
        CreateApiSourceResponse
      >("createApiSource", {
        name,
        accountKind,
        iban: accountDetails.iban || null,
        currency: accountDetails.currency,
        apiConfig,
        connectionId, // Will link the connection
      });

      resultSourceId = result.sourceId;
    }

    // Update connection to mark it as used (if not already done by createApiSource)
    if (sourceId) {
      await callCloudFunction<
        UpdateBankingConnectionRequest,
        UpdateBankingConnectionResponse
      >("updateBankingConnection", {
        connectionId,
        updates: {
          linkedSourceId: resultSourceId,
        },
      });
    }

    // Trigger initial sync via Cloud Function in background (don't await)
    callCloudFunctionBackground<SyncBankTransactionsRequest>(
      "syncBankTransactions",
      { sourceId: resultSourceId, fromYear: effectiveSyncYear }
    );

    return NextResponse.json({
      sourceId: resultSourceId,
      success: true,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Banking Accounts] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create source",
      },
      { status: 500 }
    );
  }
}

