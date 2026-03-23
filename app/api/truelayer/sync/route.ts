export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  updateDoc,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  Timestamp,
} from "firebase/firestore";
import { getTrueLayerClient } from "@/lib/truelayer";
import { TrueLayerConnection, TrueLayerApiConfig } from "@/types/truelayer";
import { TransactionSource } from "@/types/source";
import { generateDedupeHash } from "@/lib/import/deduplication";
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

const appName = "truelayer-sync";
const app = getApps().find(a => a.name === appName) || initializeApp(firebaseConfig, appName);
const db = getFirestore(app);

// Connect to emulator in development
if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_USE_EMULATORS !== "false") {
  try {
    connectFirestoreEmulator(db, "localhost", 8080);
    console.log("[TrueLayer Sync] Connected to Firestore emulator");
  } catch {
    // Already connected
  }
}

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

    // Get source
    const sourceRef = doc(db, "sources", sourceId);
    const sourceSnap = await getDoc(sourceRef);

    if (!sourceSnap.exists()) {
      return NextResponse.json(
        { error: "Source not found" },
        { status: 404 }
      );
    }

    const source = { id: sourceSnap.id, ...sourceSnap.data() } as TransactionSource;

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
    const connectionRef = doc(db, CONNECTIONS_COLLECTION, apiConfig.connectionId);
    const connectionSnap = await getDoc(connectionRef);

    if (!connectionSnap.exists()) {
      return NextResponse.json(
        { error: "TrueLayer connection not found" },
        { status: 404 }
      );
    }

    const connection = connectionSnap.data() as TrueLayerConnection;

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
        await updateDoc(connectionRef, {
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

    // Get existing transaction hashes for deduplication
    const existingQuery = query(
      collection(db, "transactions"),
      where("sourceId", "==", sourceId)
    );
    const existingSnap = await getDocs(existingQuery);
    const existingHashes = new Set(
      existingSnap.docs.map((d) => d.data().dedupeHash)
    );

    // Transform and import transactions
    const nowTs = Timestamp.now();
    let imported = 0;
    let skipped = 0;

    for (const tx of transactions) {
      // Determine if income or expense
      // TrueLayer returns amounts in whole currency units (e.g., 42.50)
      // We store amounts in cents (e.g., 4250)
      const isCredit = tx.transaction_type === "CREDIT";
      const amountCents = Math.round(Math.abs(tx.amount) * 100);
      const amount = isCredit ? amountCents : -amountCents;

      // Parse date
      const txDate = new Date(tx.timestamp);

      // Reference for dedupe
      const reference = tx.meta?.provider_reference || tx.transaction_id;

      // Generate dedupe hash (use sourceId as fallback for sources without IBAN)
      const dedupeHash = await generateDedupeHash(
        txDate,
        amount,
        source.iban ?? source.id,
        reference
      );

      // Skip if duplicate
      if (existingHashes.has(dedupeHash)) {
        skipped++;
        continue;
      }

      // Build transaction document
      const transactionDoc = {
        sourceId,
        importJobId: null,
        userId,
        date: Timestamp.fromDate(txDate),
        amount,
        currency: tx.currency,
        name: tx.description,
        partner: tx.merchant_name || null,
        partnerIban: null,
        description: null,
        reference,
        isComplete: false,
        dedupeHash,
        _original: {
          date: tx.timestamp,
          amount: tx.amount.toString(),
          rawRow: tx as unknown as Record<string, string>,
        },
        createdAt: nowTs,
        updatedAt: nowTs,
      };

      await addDoc(collection(db, "transactions"), transactionDoc);
      existingHashes.add(dedupeHash);
      imported++;
    }

    // Update source with last sync time
    await updateDoc(sourceRef, {
      "apiConfig.lastSyncAt": nowTs,
      updatedAt: nowTs,
    });

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      total: transactions.length,
    });
  } catch (error) {
    console.error("Error syncing transactions:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync transactions" },
      { status: 500 }
    );
  }
}
