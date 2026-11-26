export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { deleteOrphanRows, orphanRows } from "@/functions/src/banking/orphanTransactions";

const TRUELAYER_CONNECTIONS_COLLECTION = "truelayerConnections";
const BATCH_SIZE = 500;

/**
 * POST /api/sources/delete-orphans
 * Delete sources missing required fields, orphaned TrueLayer connections, and orphaned transactions
 *
 * Reads and writes go through the server's Admin SDK (#813): a route has no
 * signed-in User for the client SDK to authenticate as.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const db = getAdminDb();

    // === 1. Find and delete orphan sources ===
    const snapshot = await db.collection("sources").where("userId", "==", userId).get();

    const orphanSources: { id: string; name: string; reason: string }[] = [];

    // Collect valid source IDs and their TrueLayer connection IDs for reference
    const validSourceIds = new Set<string>();
    const sourceConnectionIds = new Set<string>();

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
        orphanSources.push({
          id: docSnap.id,
          name: data.name || "(unnamed)",
          reason: reasons.join(", "),
        });
      } else {
        validSourceIds.add(docSnap.id);
        // Track TrueLayer connection IDs that are still in use
        if (data.type === "api" && data.apiConfig?.provider === "truelayer" && data.apiConfig?.connectionId) {
          sourceConnectionIds.add(data.apiConfig.connectionId);
        }
      }
    }

    console.log(`Found ${orphanSources.length} orphan sources`);

    // Delete orphan sources
    for (const orphan of orphanSources) {
      console.log(`Deleting orphan source: ${orphan.id} (${orphan.name}) - ${orphan.reason}`);
    }
    await deleteAll(db, orphanSources.map((o) => db.collection("sources").doc(o.id)));

    // === 2. Find and delete orphan TrueLayer connections ===
    const connectionsSnap = await db
      .collection(TRUELAYER_CONNECTIONS_COLLECTION)
      .where("userId", "==", userId)
      .get();

    const orphanConnections: { id: string; providerId: string; reason: string }[] = [];

    for (const connDoc of connectionsSnap.docs) {
      const connData = connDoc.data();
      const connectionId = connDoc.id;

      // A connection is orphaned if no valid source references it
      if (!sourceConnectionIds.has(connectionId)) {
        orphanConnections.push({
          id: connectionId,
          providerId: connData.providerId || "(unknown)",
          reason: "no source references this connection",
        });
      }
    }

    console.log(`Found ${orphanConnections.length} orphan TrueLayer connections`);

    // Delete orphan connections
    for (const orphan of orphanConnections) {
      console.log(`Deleting orphan TrueLayer connection: ${orphan.id} - ${orphan.reason}`);
    }
    await deleteAll(db, orphanConnections.map((o) => db.collection(TRUELAYER_CONNECTIONS_COLLECTION).doc(o.id)));

    // === 3. Find and delete orphan transactions (referencing non-existent sources) ===
    const transactionsSnap = await db.collection("transactions").where("userId", "==", userId).get();
    const orphans = orphanRows(transactionsSnap.docs, validSourceIds);
    const orphanSourceIds = new Set<string>(orphans.map((d) => d.data().sourceId as string));

    // The same delete as the admin cleanup: filed years keep their evidence (#794), so a closed orphan stays.
    const { deleted: orphanTransactionCount, keptClosed: keptClosedTransactions } = await deleteOrphanRows(
      db,
      userId,
      orphans
    );

    console.log(`Found and deleted ${orphanTransactionCount} orphan transactions from ${orphanSourceIds.size} missing sources`);

    console.log(`Successfully deleted ${orphanSources.length} orphan sources, ${orphanConnections.length} orphan connections, and ${orphanTransactionCount} orphan transactions`);

    return NextResponse.json({
      success: true,
      deletedSources: orphanSources.length,
      deletedConnections: orphanConnections.length,
      deletedTransactions: orphanTransactionCount,
      keptClosedTransactions,
      orphanSourceIds: Array.from(orphanSourceIds),
      sources: orphanSources,
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

async function deleteAll(db: FirebaseFirestore.Firestore, refs: FirebaseFirestore.DocumentReference[]) {
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.delete(ref);
    await batch.commit();
  }
}
