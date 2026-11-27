export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { bearerToken, callableErrorMessage } from "@/lib/api/callable-as-caller";

const TRUELAYER_CONNECTIONS_COLLECTION = "truelayerConnections";
const BATCH_SIZE = 500;

interface DeleteSourceResult {
  deletedTransactions: number;
}

interface CleanupResult {
  orphanedBySource: Record<string, number>;
  deleted?: number;
  keptClosed?: number;
}

/**
 * POST /api/sources/delete-orphans
 * Delete sources missing required fields, orphaned TrueLayer connections, and orphaned transactions
 *
 * Reads go through the server's Admin SDK (#813). A Bank Account and its
 * Transactions are deleted by the callables, as the caller: `deleteSource`
 * (refused whole while one of its Transactions lies in the Closed stretch,
 * Files detached, Imports and linked cards cleaned up) and
 * `cleanupOrphanedTransactions` (a closed orphan stays, Files detached).
 * TrueLayer connections are no domain table; the route deletes them.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const authToken = bearerToken(request);
    if (!authToken) {
      return NextResponse.json({ error: "A Bearer token is required: the deletes run as you." }, { status: 401 });
    }
    const db = getAdminDb();

    // === 1. Find and delete orphan sources ===
    const snapshot = await db.collection("sources").where("userId", "==", userId).get();

    const brokenSources: { id: string; name: string; reason: string }[] = [];

    // TrueLayer connection IDs still in use, by a Bank Account that stays
    const sourceConnectionIds = new Set<string>();
    const connectionOf = (data: FirebaseFirestore.DocumentData) =>
      data.type === "api" && data.apiConfig?.provider === "truelayer" ? (data.apiConfig?.connectionId as string | undefined) : undefined;

    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();
      const reasons: string[] = [];

      // Check for missing required fields
      if (!data.accountKind) {
        reasons.push("missing accountKind");
      }
      if (!data.name) {
        reasons.push("missing name");
      }
      if (data.type === undefined) {
        reasons.push("missing type");
      }

      if (reasons.length > 0) {
        brokenSources.push({
          id: docSnap.id,
          name: data.name || "(unnamed)",
          reason: reasons.join(", "),
        });
      } else {
        const connectionId = connectionOf(data);
        if (connectionId) sourceConnectionIds.add(connectionId);
      }
    }

    console.log(`Found ${brokenSources.length} orphan sources`);

    // Each through the deleteSource callable; one it refuses stays, with why.
    const orphanSources: typeof brokenSources = [];
    const keptSources: { id: string; name: string; reason: string }[] = [];
    let deletedWithSources = 0;
    for (const broken of brokenSources) {
      console.log(`Deleting orphan source: ${broken.id} (${broken.name}) - ${broken.reason}`);
      try {
        const result = await callFirebaseFunction<{ sourceId: string }, DeleteSourceResult>(
          "deleteSource",
          { sourceId: broken.id },
          authToken
        );
        deletedWithSources += result.deletedTransactions ?? 0;
        orphanSources.push(broken);
      } catch (error) {
        keptSources.push({ id: broken.id, name: broken.name, reason: callableErrorMessage(error) });
        const kept = snapshot.docs.find((d) => d.id === broken.id)!.data();
        const connectionId = connectionOf(kept);
        if (connectionId) sourceConnectionIds.add(connectionId);
      }
    }

    // === 2. Find and delete orphan TrueLayer connections ===
    const connectionsSnap = await db
      .collection(TRUELAYER_CONNECTIONS_COLLECTION)
      .where("userId", "==", userId)
      .get();

    const orphanConnections: { id: string; providerId: string; reason: string }[] = [];

    for (const connDoc of connectionsSnap.docs) {
      const connData = connDoc.data();
      const connectionId = connDoc.id;

      // A connection is orphaned if no remaining source references it
      if (!sourceConnectionIds.has(connectionId)) {
        orphanConnections.push({
          id: connectionId,
          providerId: connData.providerId || "(unknown)",
          reason: "no source references this connection",
        });
      }
    }

    console.log(`Found ${orphanConnections.length} orphan TrueLayer connections`);

    for (const orphan of orphanConnections) {
      console.log(`Deleting orphan TrueLayer connection: ${orphan.id} - ${orphan.reason}`);
    }
    const refs = orphanConnections.map((o) => db.collection(TRUELAYER_CONNECTIONS_COLLECTION).doc(o.id));
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.delete(ref);
      await batch.commit();
    }

    // === 3. Orphan transactions (referencing non-existent sources), through the cleanup callable ===
    let cleanup: CleanupResult;
    try {
      cleanup = await callFirebaseFunction<{ dryRun: boolean }, CleanupResult>(
        "cleanupOrphanedTransactions",
        { dryRun: false },
        authToken
      );
    } catch (error) {
      // Bank Accounts and connections are gone by now: say so, and which step failed.
      console.error("Error deleting orphan transactions:", error);
      return NextResponse.json(
        {
          success: false,
          failedStep: "orphanTransactions",
          error: callableErrorMessage(error),
          deletedSources: orphanSources.length,
          deletedConnections: orphanConnections.length,
          deletedTransactions: deletedWithSources,
          sources: orphanSources,
          keptSources,
          connections: orphanConnections,
        },
        { status: 500 }
      );
    }
    const orphanSourceIds = Object.keys(cleanup.orphanedBySource ?? {});
    const deletedTransactions = deletedWithSources + (cleanup.deleted ?? 0);
    const keptClosedTransactions = cleanup.keptClosed ?? 0;

    console.log(
      `Successfully deleted ${orphanSources.length} orphan sources (${keptSources.length} kept), ` +
        `${orphanConnections.length} orphan connections, and ${deletedTransactions} transactions`
    );

    return NextResponse.json({
      success: true,
      deletedSources: orphanSources.length,
      deletedConnections: orphanConnections.length,
      deletedTransactions,
      keptClosedTransactions,
      orphanSourceIds,
      sources: orphanSources,
      keptSources,
      connections: orphanConnections,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Error deleting orphans:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete orphans" },
      { status: 500 }
    );
  }
}
