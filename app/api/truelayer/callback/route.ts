export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getTrueLayerClient } from "@/lib/truelayer";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";

// Written through the server's Admin SDK (#813): a route has no signed-in
// User for the client SDK to authenticate as.
const CONNECTIONS_COLLECTION = "truelayerConnections";

/**
 * POST /api/truelayer/callback
 * OAuth callback from TrueLayer (uses form_post response_mode)
 */
export async function POST(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  try {
    const userId = await getServerUserIdWithFallback(request);
    const formData = await request.formData();
    const code = formData.get("code") as string;
    const state = formData.get("state") as string;
    const error = formData.get("error") as string;

    // Handle errors from TrueLayer
    if (error) {
      const errorDescription = formData.get("error_description") as string;
      const errorMessage = encodeURIComponent(errorDescription || error);
      return NextResponse.redirect(
        new URL(`/sources/connect/error?message=${errorMessage}`, baseUrl)
      );
    }

    if (!code) {
      return NextResponse.redirect(
        new URL("/sources/connect/error?message=Missing%20authorization%20code", baseUrl)
      );
    }

    // Parse state to get provider info and sourceId
    let sourceId: string | null = null;
    let providerId: string = "unknown";
    let providerName: string = "Unknown Bank";
    let providerLogo: string | null = null;

    if (state) {
      try {
        const stateData = JSON.parse(Buffer.from(state, "base64url").toString());
        sourceId = stateData.sourceId;
        providerId = stateData.providerId || "unknown";
        providerName = stateData.providerName || "Unknown Bank";
        providerLogo = stateData.providerLogo || null;
      } catch {
        // Ignore state parsing errors
      }
    }

    // Exchange code for tokens
    const client = getTrueLayerClient();
    const tokens = await client.exchangeCode(code);

    // Get accounts
    const accounts = await client.getAccounts(tokens.access_token);
    const accountIds = accounts.map(a => a.account_id);

    // Calculate token expiration
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Store connection in Firestore
    const connectionDoc = {
      providerId,
      providerName,
      providerLogo,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Timestamp.fromDate(expiresAt),
      accountIds,
      userId,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      ...(sourceId && { linkToSourceId: sourceId }),
    };

    const docRef = await getAdminDb().collection(CONNECTIONS_COLLECTION).add(connectionDoc);

    // Redirect to account selection
    const params = new URLSearchParams({ connectionId: docRef.id });
    if (sourceId) {
      params.set("sourceId", sourceId);
    }

    return NextResponse.redirect(
      new URL(`/sources/connect/accounts?${params.toString()}`, baseUrl)
    );
  } catch (err) {
    const unauthorized = unauthorizedResponse(err);
    if (unauthorized) return unauthorized;
    console.error("Error handling TrueLayer callback:", err);
    const message = encodeURIComponent(
      err instanceof Error ? err.message : "An unexpected error occurred"
    );
    return NextResponse.redirect(
      new URL(`/sources/connect/error?message=${message}`, baseUrl)
    );
  }
}

/**
 * GET /api/truelayer/callback
 * Fallback for GET requests (shouldn't happen with form_post)
 */
export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  // Handle as if it were a POST
  if (error) {
    const errorDescription = request.nextUrl.searchParams.get("error_description");
    const errorMessage = encodeURIComponent(errorDescription || error);
    return NextResponse.redirect(
      new URL(`/sources/connect/error?message=${errorMessage}`, baseUrl)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/sources/connect/error?message=Missing%20authorization%20code", baseUrl)
    );
  }

  // For GET requests, redirect to an intermediate page that will handle the flow
  const params = new URLSearchParams({ code });
  if (state) params.set("state", state);

  return NextResponse.redirect(
    new URL(`/sources/connect/processing?${params.toString()}`, baseUrl)
  );
}
