export const dynamic = "force-dynamic";

/**
 * Plaid Link Token API
 *
 * Creates a link token for initializing Plaid Link on the client side.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { PlaidClient, PlaidEnvironment } from "@/lib/plaid/client";

// EU countries supported
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

    const client = new PlaidClient({
      clientId,
      secret,
      environment,
    });

    const body = await request.json().catch(() => ({}));
    const {
      countryCodes = PLAID_EU_COUNTRIES,
      language = "en",
    } = body;

    const response = await client.createLinkToken({
      userId,
      countryCodes,
      language,
    });

    return NextResponse.json({
      linkToken: response.link_token,
      expiration: response.expiration,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Plaid Link Token] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create link token" },
      { status: 500 }
    );
  }
}
