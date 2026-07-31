export const dynamic = "force-dynamic";

/**
 * finAPI Web Form Callback Handler
 *
 * Handles the redirect after user completes bank authentication in finAPI Web Form.
 * Updates the banking connection status and retrieves account information.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { FinapiClient, FinapiEnvironment } from "@/lib/finapi/client";
import { Timestamp } from "firebase-admin/firestore";

export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      // Redirect to login if not authenticated
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const searchParams = request.nextUrl.searchParams;
    const connectionId = searchParams.get("connectionId");
    const webFormId = searchParams.get("webFormId");

    if (!connectionId) {
      return NextResponse.redirect(
        new URL("/sources/connect?error=missing_connection_id", request.url)
      );
    }

    const clientId = process.env.FINAPI_CLIENT_ID;
    const clientSecret = process.env.FINAPI_CLIENT_SECRET;
    const environment = (process.env.FINAPI_ENVIRONMENT || "sandbox") as FinapiEnvironment;

    if (!clientId || !clientSecret) {
      return NextResponse.redirect(
        new URL("/sources/connect?error=finapi_not_configured", request.url)
      );
    }

    const db = getAdminDb();
    const connectionRef = db.collection("bankingConnections").doc(connectionId);
    const connectionDoc = await connectionRef.get();

    if (!connectionDoc.exists) {
      return NextResponse.redirect(
        new URL("/sources/connect?error=connection_not_found", request.url)
      );
    }

    const connection = connectionDoc.data();

    // Verify ownership
    if (connection?.userId !== userId) {
      return NextResponse.redirect(
        new URL("/sources/connect?error=unauthorized", request.url)
      );
    }

    const client = new FinapiClient({
      clientId,
      clientSecret,
      environment,
    });

    // Get stored user token from connection
    const userToken = connection.providerData?.userAccessToken as string;
    const webFormIdToCheck = webFormId || connection.providerConnectionId;

    if (!userToken || !webFormIdToCheck) {
      return NextResponse.redirect(
        new URL("/sources/connect?error=invalid_connection_state", request.url)
      );
    }

    // Check web form status
    const webForm = await client.getWebForm(webFormIdToCheck, userToken);

    if (webForm.status === "COMPLETED" && webForm.payload?.bankConnectionId) {
      // Get the bank connection details
      const bankConnection = await client.getBankConnection(
        webForm.payload.bankConnectionId,
        userToken
      );

      // Get accounts for the connection
      const accountsResponse = await client.getAccounts(userToken, {
        bankConnectionIds: [webForm.payload.bankConnectionId],
      });

      // Update the connection in Firestore
      await connectionRef.update({
        status: "linked",
        accountIds: accountsResponse.accounts.map((a) => String(a.id)),
        providerData: {
          ...connection.providerData,
          bankConnectionId: webForm.payload.bankConnectionId,
          bankId: bankConnection.bankId,
        },
        updatedAt: Timestamp.now(),
      });

      // Redirect to account selection
      return NextResponse.redirect(
        new URL(`/sources/connect/accounts?connectionId=${connectionId}`, request.url)
      );
    } else if (webForm.status === "ABORTED" || webForm.status === "TIMED_OUT") {
      // Update connection as rejected
      await connectionRef.update({
        status: "rejected",
        updatedAt: Timestamp.now(),
      });

      const errorMessage = webForm.payload?.errorMessage || webForm.status.toLowerCase();
      return NextResponse.redirect(
        new URL(`/sources/connect?error=${encodeURIComponent(errorMessage)}`, request.url)
      );
    } else {
      // Still in progress - redirect back to wait or show status
      return NextResponse.redirect(
        new URL(`/sources/connect/pending?connectionId=${connectionId}`, request.url)
      );
    }
  } catch (error) {
    if (unauthorizedResponse(error)) {
      // A BROWSER lands on this route from the finAPI web form — the
      // route's own (previously dead) intent is redirect-to-login, not the
      // JSON 401 the fetch-style API routes answer.
      return NextResponse.redirect(new URL("/login", request.url));
    }
    console.error("[finAPI Callback] Error:", error);
    return NextResponse.redirect(
      new URL(
        `/sources/connect?error=${encodeURIComponent(
          error instanceof Error ? error.message : "callback_failed"
        )}`,
        request.url
      )
    );
  }
}
