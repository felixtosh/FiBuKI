export const dynamic = "force-dynamic";

/**
 * Plaid Token Exchange API
 *
 * Exchanges a public_token from Plaid Link for an access_token
 * and creates a banking connection record.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { PlaidClient, PlaidEnvironment } from "@/lib/plaid/client";
import { Timestamp } from "firebase-admin/firestore";

// EU countries for institution lookup
const PLAID_EU_COUNTRIES = ["GB", "DE", "FR", "ES", "NL", "IE"];

export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const clientId = process.env.PLAID_CLIENT_ID;
    const secret = process.env.PLAID_SECRET;
    const environment = (process.env.PLAID_ENVIRONMENT || "sandbox") as PlaidEnvironment;

    if (!clientId || !secret) {
      return NextResponse.json(
        { error: "Plaid is not configured" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { publicToken, institutionId, institutionName, sourceId } = body;

    if (!publicToken) {
      return NextResponse.json(
        { error: "Public token is required" },
        { status: 400 }
      );
    }

    const client = new PlaidClient({
      clientId,
      secret,
      environment,
    });

    // Exchange public token for access token
    const exchangeResponse = await client.exchangePublicToken(publicToken);

    // Get accounts
    const { accounts } = await client.getAccounts(exchangeResponse.access_token);

    // Get institution info if ID provided
    let instName = institutionName;
    let instLogo: string | undefined;
    if (institutionId) {
      try {
        const { institution } = await client.getInstitution(
          institutionId,
          PLAID_EU_COUNTRIES
        );
        instName = instName || institution.name;
        instLogo = institution.logo;
      } catch {
        // Ignore errors - use provided name
      }
    }

    // Store connection in Firestore
    const db = getAdminDb();
    const now = Timestamp.now();
    // 90 days expiration (standard Plaid consent period)
    const expiresAt = Timestamp.fromDate(
      new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
    );

    const connectionDoc = await db.collection("bankingConnections").add({
      providerId: "plaid",
      providerConnectionId: exchangeResponse.item_id,
      institutionId: institutionId || "unknown",
      institutionName: instName || "Bank",
      institutionLogo: instLogo || null,
      status: "linked",
      accountIds: accounts.map((a) => a.account_id),
      expiresAt,
      providerData: {
        accessToken: exchangeResponse.access_token,
        itemId: exchangeResponse.item_id,
      },
      linkToSourceId: sourceId || null,
      userId,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({
      connectionId: connectionDoc.id,
      itemId: exchangeResponse.item_id,
      accounts: accounts.map((a) => ({
        accountId: a.account_id,
        name: a.name,
        officialName: a.official_name,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask,
        currency: a.balances?.iso_currency_code || "EUR",
      })),
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Plaid Exchange] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Token exchange failed" },
      { status: 500 }
    );
  }
}
