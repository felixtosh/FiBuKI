export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { FinapiClient, FinapiEnvironment } from "@/lib/finapi/client";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/sources/[id]/disconnect
 * Disconnect a bank connection from a source and delete synced transactions
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: sourceId } = await params;
    const db = getAdminDb();

    console.log(`[Source Disconnect] Disconnecting source: ${sourceId}`);

    // Get the source
    const sourceDoc = await db.collection("sources").doc(sourceId).get();

    if (!sourceDoc.exists) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const source = sourceDoc.data()!;

    if (source.userId !== userId) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    if (source.type !== "api" || !source.apiConfig) {
      return NextResponse.json(
        { error: "Source is not connected to a bank" },
        { status: 400 }
      );
    }

    const apiConfig = source.apiConfig;

    // Delete finAPI bank connection if applicable
    if (apiConfig.provider === "finapi" && apiConfig.bankConnectionId && apiConfig.userAccessToken) {
      try {
        const clientId = process.env.FINAPI_CLIENT_ID;
        const clientSecret = process.env.FINAPI_CLIENT_SECRET;
        const environment = (process.env.FINAPI_ENVIRONMENT || "sandbox") as FinapiEnvironment;

        if (clientId && clientSecret) {
          const client = new FinapiClient({ clientId, clientSecret, environment });
          await client.deleteBankConnection(apiConfig.bankConnectionId, apiConfig.userAccessToken);
          console.log(`[Source Disconnect] Deleted finAPI bank connection: ${apiConfig.bankConnectionId}`);
        }
      } catch (err) {
        // Log but don't fail - connection might already be deleted or expired
        console.error("[Source Disconnect] Failed to delete finAPI connection:", err);
      }
    }

    // Delete all transactions for this source (both API synced and CSV imported)
    const transactionsQuery = await db
      .collection("transactions")
      .where("sourceId", "==", sourceId)
      .get();

    let deletedTransactions = 0;
    const BATCH_SIZE = 500;

    // Delete in batches
    for (let i = 0; i < transactionsQuery.docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const slice = transactionsQuery.docs.slice(i, i + BATCH_SIZE);

      for (const txDoc of slice) {
        batch.delete(txDoc.ref);
        deletedTransactions++;
      }

      await batch.commit();
    }

    console.log(`[Source Disconnect] Deleted ${deletedTransactions} transactions`);

    // Update source to remove API connection
    await db.collection("sources").doc(sourceId).update({
      type: "csv",
      apiConfig: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[Source Disconnect] Source ${sourceId} disconnected successfully`);

    return NextResponse.json({
      success: true,
      deletedTransactions,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Source Disconnect] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to disconnect" },
      { status: 500 }
    );
  }
}
