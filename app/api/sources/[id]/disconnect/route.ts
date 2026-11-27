export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { FieldValue } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { FinapiClient, FinapiEnvironment } from "@/lib/finapi/client";
import { closedRefusal, readFiscalYears, stretchOf } from "@/functions/src/fiscalYears/settings";
import { toDateSafe } from "@/lib/utils";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { bearerToken } from "@/lib/api/callable-as-caller";
import { bankConnectionOf, isBankConnectionStillUsed } from "@/functions/src/banking/bankConnectionUse";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/sources/[id]/disconnect
 * Disconnect a bank connection from a source and delete synced transactions
 *
 * Reads and the Bank Account's update go through the server's Admin SDK; the
 * User's Transactions are deleted by a callable, as the User (#813).
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

    // A disconnect deletes every row of this Bank Account (both API synced and
    // CSV imported), whatever user id a row carries. Filed years keep their
    // evidence (#794): it is refused while one of exactly those rows is dated
    // in the Closed stretch (#813).
    const rows = await db.collection("transactions").where("sourceId", "==", sourceId).get();
    // Only a dated row can lie in the Closed stretch, so the settings are read
    // only when there is one.
    const dates = rows.docs.map((d) => toDateSafe(d.data().date)).filter((d): d is Date => d !== null);
    const fiscalYears = dates.length > 0 ? await readFiscalYears(db, userId) : null;
    if (fiscalYears && dates.some((date) => stretchOf(fiscalYears, date) === "closed")) {
      return NextResponse.json(
        { error: closedRefusal(fiscalYears, "A Transaction of this Bank Account") },
        { status: 409 }
      );
    }

    // The deletes run as the User, through the callable; without a token none can.
    const authToken = bearerToken(request);
    if (!authToken) {
      return NextResponse.json({ error: "A Bearer token is required: the deletes run as you." }, { status: 401 });
    }

    // Delete the rows just checked. The User's go through the
    // deleteTransactionsBySource callable, as the User: every File comes off
    // them first (#612) and the month's quota count goes down with them.
    const { deleted } = await callFirebaseFunction<{ sourceId: string }, { deleted: number }>(
      "deleteTransactionsBySource",
      { sourceId },
      authToken
    );
    let deletedTransactions = deleted ?? 0;

    // The rest carry no user id or another one. No File Connection reaches
    // them (the writer connects only the User's own Transactions), so they go
    // as they are.
    const BATCH_SIZE = 500;
    const others = rows.docs.filter((d) => d.data().userId !== userId);
    for (let i = 0; i < others.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const txDoc of others.slice(i, i + BATCH_SIZE)) {
        batch.delete(txDoc.ref);
        deletedTransactions++;
      }
      await batch.commit();
    }

    console.log(`[Source Disconnect] Deleted ${deletedTransactions} transactions`);

    // Only now the provider's bank connection: a step above that fails leaves
    // the Bank Account connected, with its connection still there to sync.
    // While another of the User's Bank Accounts syncs through it, it stays
    // and only this Bank Account is detached (#815).
    const connection = bankConnectionOf(source);
    const connectionStillUsed = connection !== null && (await isBankConnectionStillUsed(db, userId, connection, sourceId));
    if (connectionStillUsed) {
      console.log(`[Source Disconnect] Kept the ${connection.provider} connection: another Bank Account still uses it`);
    }
    if (apiConfig.provider === "finapi" && apiConfig.bankConnectionId && apiConfig.userAccessToken && !connectionStillUsed) {
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
