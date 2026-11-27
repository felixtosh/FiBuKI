export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getTrueLayerClient } from "@/lib/truelayer";
import { importTrueLayerTransactions } from "@/lib/truelayer/import-transactions";
import { TrueLayerConnection, TrueLayerApiConfig } from "@/types/truelayer";
import { TransactionSource } from "@/types/source";
import { getServerUserIdWithFallback, isServerUserAdmin, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";

// Reads and writes go through the server's Admin SDK (#813): a route has no
// signed-in User for the client SDK to authenticate as.
const CONNECTIONS_COLLECTION = "truelayerConnections";

/**
 * POST /api/truelayer/sync
 * Sync transactions for a source
 *
 * Body: { sourceId }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { sourceId } = body;

    if (!sourceId) {
      return NextResponse.json(
        { error: "sourceId is required" },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // Get source
    const sourceSnap = await db.collection("sources").doc(sourceId).get();

    if (!sourceSnap.exists) {
      return NextResponse.json(
        { error: "Source not found" },
        { status: 404 }
      );
    }

    const source = { id: sourceSnap.id, ...sourceSnap.data() } as TransactionSource;

    // Every user shares one database, so the source must be the caller's
    // before its tokens are used or transactions are written into it. Not
    // yours answers like not found.
    if (source.userId !== userId) {
      return NextResponse.json(
        { error: "Source not found" },
        { status: 404 }
      );
    }

    if (source.type !== "api" || !source.apiConfig) {
      return NextResponse.json(
        { error: "Source is not API-connected" },
        { status: 400 }
      );
    }

    const apiConfig = source.apiConfig as unknown as TrueLayerApiConfig;
    if (apiConfig.provider !== "truelayer") {
      return NextResponse.json(
        { error: "Source is not a TrueLayer connection" },
        { status: 400 }
      );
    }

    // Get connection
    const connectionRef = db.collection(CONNECTIONS_COLLECTION).doc(apiConfig.connectionId);
    const connectionSnap = await connectionRef.get();

    if (!connectionSnap.exists) {
      return NextResponse.json(
        { error: "TrueLayer connection not found" },
        { status: 404 }
      );
    }

    const connection = connectionSnap.data() as unknown as TrueLayerConnection;

    // The connection id comes from the source's config; check it anyway, so
    // a source pointing at someone else's connection cannot use its tokens.
    if (connection.userId !== userId) {
      return NextResponse.json(
        { error: "TrueLayer connection not found" },
        { status: 404 }
      );
    }

    // Check if token needs refresh
    const now = new Date();
    const expiresAt = connection.tokenExpiresAt.toDate();

    let accessToken = connection.accessToken;

    if (now >= expiresAt) {
      // Try to refresh token
      try {
        const client = getTrueLayerClient();
        const tokens = await client.refreshToken(connection.refreshToken);
        accessToken = tokens.access_token;

        // Update connection with new tokens
        const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);
        await connectionRef.update({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: Timestamp.fromDate(newExpiresAt),
          updatedAt: Timestamp.now(),
        });
      } catch (refreshError) {
        return NextResponse.json(
          { error: "Token expired and refresh failed. Please reconnect the bank." },
          { status: 401 }
        );
      }
    }

    // Fetch transactions from TrueLayer
    const client = getTrueLayerClient();

    // Get transactions from last 90 days (TrueLayer limit)
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 90);
    const toDate = new Date();

    const transactions = await client.getTransactions(
      accessToken,
      apiConfig.accountId,
      fromDate.toISOString().split("T")[0],
      toDate.toISOString().split("T")[0]
    );

    // A Bank Account without an IBAN is named by its id in the dedupe hash.
    const result = await importTrueLayerTransactions(db, {
      userId,
      sourceId,
      sourceIdentifier: source.iban ?? source.id,
      transactions,
      isAdmin: await isServerUserAdmin(request),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Error syncing transactions:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync transactions" },
      { status: 500 }
    );
  }
}
