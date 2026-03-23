export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  doc,
} from "firebase/firestore";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";

// Initialize Firebase for server-side
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyDhxXMbHgaD1z9n0bkuVaSRmmiCrbNL-l4",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "taxstudio-f12fb.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "taxstudio-f12fb.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "534848611676",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:534848611676:web:8a3d1ede57c65b7e884d99",
};

const appName = "delete-orphans";
const app = getApps().find(a => a.name === appName) || initializeApp(firebaseConfig, appName);
const db = getFirestore(app);

// Connect to emulator in development
if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_USE_EMULATORS !== "false") {
  try {
    connectFirestoreEmulator(db, "localhost", 8080);
    console.log("[Delete Orphans] Connected to Firestore emulator");
  } catch {
    // Already connected
  }
}

const TRUELAYER_CONNECTIONS_COLLECTION = "truelayerConnections";

/**
 * POST /api/sources/delete-orphans
 * Delete sources missing required fields, orphaned TrueLayer connections, and orphaned transactions
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    // === 1. Find and delete orphan sources ===
    const sourcesQuery = query(
      collection(db, "sources"),
      where("userId", "==", userId)
    );

    const snapshot = await getDocs(sourcesQuery);

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
      await deleteDoc(doc(db, "sources", orphan.id));
    }

    // === 2. Find and delete orphan TrueLayer connections ===
    const connectionsQuery = query(
      collection(db, TRUELAYER_CONNECTIONS_COLLECTION),
      where("userId", "==", userId)
    );

    const connectionsSnap = await getDocs(connectionsQuery);

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
      await deleteDoc(doc(db, TRUELAYER_CONNECTIONS_COLLECTION, orphan.id));
    }

    // === 3. Find and delete orphan transactions (referencing non-existent sources) ===
    const transactionsQuery = query(
      collection(db, "transactions"),
      where("userId", "==", userId)
    );

    const transactionsSnap = await getDocs(transactionsQuery);

    let orphanTransactionCount = 0;
    const orphanSourceIds = new Set<string>();

    for (const txDoc of transactionsSnap.docs) {
      const txData = txDoc.data();
      const sourceId = txData.sourceId;

      // A transaction is orphaned if its sourceId doesn't match any valid source
      if (sourceId && !validSourceIds.has(sourceId)) {
        orphanSourceIds.add(sourceId);
        await deleteDoc(txDoc.ref);
        orphanTransactionCount++;
      }
    }

    console.log(`Found and deleted ${orphanTransactionCount} orphan transactions from ${orphanSourceIds.size} missing sources`);

    console.log(`Successfully deleted ${orphanSources.length} orphan sources, ${orphanConnections.length} orphan connections, and ${orphanTransactionCount} orphan transactions`);

    return NextResponse.json({
      success: true,
      deletedSources: orphanSources.length,
      deletedConnections: orphanConnections.length,
      deletedTransactions: orphanTransactionCount,
      orphanSourceIds: Array.from(orphanSourceIds),
      sources: orphanSources,
      connections: orphanConnections,
    });
  } catch (error) {
    console.error("Error deleting orphans:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete orphans" },
      { status: 500 }
    );
  }
}
