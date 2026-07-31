export const dynamic = "force-dynamic";

/**
 * Get Banking Connection Status
 *
 * For finAPI Web Form connections:
 * - If pending, checks web form status
 * - If web form completed, gets bank connection and accounts
 * - Updates connection document with new status
 *
 * Uses Cloud Functions for all Firestore writes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { FinapiClient, FinapiEnvironment } from "@/lib/finapi/client";
import { callCloudFunction, setAuthToken } from "@/lib/firebase/callable-server";
import {
  UpdateBankingConnectionRequest,
  UpdateBankingConnectionResponse,
  UpdateSourceApiConfigRequest,
  UpdateSourceApiConfigResponse,
} from "@/types/banking-sync";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: connectionId } = await params;
    const db = getAdminDb();

    // Get connection
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

    let connection = connectionDoc.data()!;

    // Verify ownership
    if (connection.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const clientId = process.env.FINAPI_CLIENT_ID;
    const clientSecret = process.env.FINAPI_CLIENT_SECRET;
    const environment = (process.env.FINAPI_ENVIRONMENT || "sandbox") as FinapiEnvironment;

    let accounts: Array<{
      accountId: string;
      iban: string;
      ownerName?: string;
      status: string;
    }> = [];

    // For finAPI pending connections, check web form status
    if (
      connection.providerId === "finapi" &&
      connection.status === "pending" &&
      connection.providerConnectionId &&
      clientId &&
      clientSecret
    ) {
      const client = new FinapiClient({ clientId, clientSecret, environment });
      const userToken = connection.providerData?.userAccessToken as string;

      if (userToken) {
        try {
          // Check web form status
          const webForm = await client.getWebForm(
            connection.providerConnectionId,
            userToken
          );

          console.log("[Banking Connection] Web form status:", webForm.status);

          // Check if web form completed OR if bank connections exist (fallback)
          let bankConnectionId: number | null = null;

          // Get the expected bank ID from our connection record
          const expectedBankId = connection.institutionId ? parseInt(connection.institutionId, 10) : null;

          if (webForm.status === "COMPLETED" && webForm.payload?.bankConnectionId) {
            bankConnectionId = webForm.payload.bankConnectionId;
          } else if (webForm.status === "COMPLETED_WITH_ERROR") {
            // Check if connection was partially created despite error (e.g., "already connected")
            console.log("[Banking Connection] Web form error:", webForm.payload?.errorMessage);
            const connectionsResponse = await client.getBankConnections(userToken);
            // Note: finAPI v2 returns bank info nested in `bank` object
            const matchingConnection = expectedBankId
              ? connectionsResponse.connections.find(c => {
                  const bankData = (c as unknown as { bank?: { id: number } }).bank;
                  const connBankId = bankData?.id || c.bankId;
                  return connBankId === expectedBankId;
                })
              : null;
            if (matchingConnection) {
              bankConnectionId = matchingConnection.id;
              console.log("[Banking Connection] Found matching connection despite error:", bankConnectionId);

              // Update existing sources with fresh tokens (for "already connected" re-auth case)
              const sourcesToUpdate = await db
                .collection("sources")
                .where("userId", "==", userId)
                .where("apiConfig.bankConnectionId", "==", bankConnectionId)
                .get();

              if (!sourcesToUpdate.empty) {
                // Update each source via callable
                for (const sourceDoc of sourcesToUpdate.docs) {
                  await callCloudFunction<
                    UpdateSourceApiConfigRequest,
                    UpdateSourceApiConfigResponse
                  >("updateSourceApiConfig", {
                    sourceId: sourceDoc.id,
                    apiConfig: {
                      userAccessToken: userToken,
                      userRefreshToken: connection.providerData?.userRefreshToken as string,
                      tokenExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
                    },
                  });
                }
                console.log(`[Banking Connection] Updated ${sourcesToUpdate.size} sources with fresh tokens`);
              }
            } else {
              // No matching connection created - mark as rejected with error message
              const errorMsg = webForm.payload?.errorMessage || "Bank connection failed";
              await callCloudFunction<
                UpdateBankingConnectionRequest,
                UpdateBankingConnectionResponse
              >("updateBankingConnection", {
                connectionId,
                updates: {
                  status: "rejected",
                  statusMessage: errorMsg,
                },
              });
              connection.status = "rejected";
              connection.statusMessage = errorMsg;
            }
          } else if (webForm.status === "IN_PROGRESS" || webForm.status === "NOT_YET_OPENED") {
            // Web form still in progress - only use connection if it matches our expected bank
            // This prevents returning accounts from a previous successful connection
            const connectionsResponse = await client.getBankConnections(userToken);
            // Note: finAPI v2 returns bank info nested in `bank` object
            const matchingConnection = expectedBankId
              ? connectionsResponse.connections.find(c => {
                  const bankData = (c as unknown as { bank?: { id: number } }).bank;
                  const connBankId = bankData?.id || c.bankId;
                  return connBankId === expectedBankId;
                })
              : null;
            if (matchingConnection) {
              bankConnectionId = matchingConnection.id;
              console.log("[Banking Connection] Found matching existing connection:", bankConnectionId);
            }
            // If no matching connection found, status stays pending (user hasn't completed yet)
          }

          if (bankConnectionId) {

            // Get bank connection details
            const bankConnection = await client.getBankConnection(
              bankConnectionId,
              userToken
            );

            // Update our connection document via callable
            await callCloudFunction<
              UpdateBankingConnectionRequest,
              UpdateBankingConnectionResponse
            >("updateBankingConnection", {
              connectionId,
              updates: {
                status: "linked",
                providerData: {
                  ...connection.providerData,
                  bankConnectionId,
                  accountIds: bankConnection.accountIds,
                },
              },
            });

            // Update local connection object for response
            connection = {
              ...connection,
              status: "linked",
              providerData: {
                ...connection.providerData,
                bankConnectionId,
                accountIds: bankConnection.accountIds,
              },
            };

            // Get accounts
            const accountsResponse = await client.getAccounts(userToken, {
              bankConnectionIds: [bankConnectionId],
            });

            accounts = accountsResponse.accounts.map((a) => ({
              accountId: String(a.id),
              iban: a.iban || "",
              ownerName: a.accountHolderName || a.accountName || undefined,
              status: a.accountType,
            }));
          } else if (webForm.status === "ABORTED" || webForm.status === "TIMED_OUT") {
            // Web form failed
            await callCloudFunction<
              UpdateBankingConnectionRequest,
              UpdateBankingConnectionResponse
            >("updateBankingConnection", {
              connectionId,
              updates: {
                status: "rejected",
              },
            });
            connection.status = "rejected";
          }
          // Otherwise status is still IN_PROGRESS or NOT_YET_OPENED
        } catch (err) {
          console.error("[Banking Connection] Error checking web form:", err);
        }
      }
    }

    // If already linked, get accounts
    if (
      connection.providerId === "finapi" &&
      connection.status === "linked" &&
      connection.providerData?.bankConnectionId &&
      accounts.length === 0
    ) {
      if (clientId && clientSecret && connection.providerData?.userAccessToken) {
        const client = new FinapiClient({ clientId, clientSecret, environment });

        try {
          const accountsResponse = await client.getAccounts(
            connection.providerData.userAccessToken as string,
            {
              bankConnectionIds: [connection.providerData.bankConnectionId as number],
            }
          );

          accounts = accountsResponse.accounts.map((a) => ({
            accountId: String(a.id),
            iban: a.iban || "",
            ownerName: a.accountHolderName || a.accountName || undefined,
            status: a.accountType,
          }));
        } catch (err) {
          console.error("[Banking Connection] Error fetching accounts:", err);
        }
      }
    }

    return NextResponse.json({
      connectionId,
      status: connection.status,
      statusMessage: connection.statusMessage || null,
      providerId: connection.providerId,
      institutionName: connection.institutionName,
      institutionLogo: connection.institutionLogo,
      accounts,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Banking Connection] Error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to get connection",
      },
      { status: 500 }
    );
  }
}
