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
  Timestamp,
} from "firebase/firestore";
import { getTrueLayerClient, getAccountIban } from "@/lib/truelayer";
import { TrueLayerConnection, TrueLayerApiConfig } from "@/types/truelayer";
import { normalizeIban } from "@/lib/import/deduplication";
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

const appName = "truelayer-accounts";
const app = getApps().find(a => a.name === appName) || initializeApp(firebaseConfig, appName);
const db = getFirestore(app);

// Connect to emulator in development
if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_USE_EMULATORS !== "false") {
  try {
    connectFirestoreEmulator(db, "localhost", 8080);
    console.log("[TrueLayer Accounts] Connected to Firestore emulator");
  } catch {
    // Already connected
  }
}

const CONNECTIONS_COLLECTION = "truelayerConnections";

/**
 * GET /api/truelayer/accounts?connectionId={id}
 * List accounts from a TrueLayer connection
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const connectionId = request.nextUrl.searchParams.get("connectionId");

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId is required" },
        { status: 400 }
      );
    }

    // Get connection from Firestore
    const connectionRef = doc(db, CONNECTIONS_COLLECTION, connectionId);
    const connectionSnap = await getDoc(connectionRef);

    if (!connectionSnap.exists()) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    const connection = connectionSnap.data() as TrueLayerConnection;

    if (connection.userId !== userId) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    // Fetch accounts from TrueLayer
    const client = getTrueLayerClient();
    const accounts = await client.getAccounts(connection.accessToken);

    // Format accounts for the UI
    const formattedAccounts = accounts.map((account) => ({
      accountId: account.account_id,
      iban: getAccountIban(account) || "",
      ownerName: account.display_name,
      status: "READY",
      currency: account.currency,
      accountType: account.account_type,
    }));

    return NextResponse.json({
      accounts: formattedAccounts,
      provider: {
        id: connection.providerId,
        name: connection.providerName,
        logo: connection.providerLogo,
      },
    });
  } catch (error) {
    console.error("Error fetching accounts:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch accounts" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/truelayer/accounts
 * Create or link a source from a TrueLayer account
 *
 * Body: { connectionId, accountId, name?, sourceId? }
 * - If sourceId provided: link to existing source
 * - If name provided: create new source
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { connectionId, accountId, name, sourceId } = body;

    console.log("[TrueLayer Accounts POST] Request body:", { connectionId, accountId, name, sourceId });

    if (!connectionId || !accountId) {
      console.log("[TrueLayer Accounts POST] Missing required fields");
      return NextResponse.json(
        { error: "connectionId and accountId are required" },
        { status: 400 }
      );
    }

    // Get connection from Firestore
    const connectionRef = doc(db, CONNECTIONS_COLLECTION, connectionId);
    const connectionSnap = await getDoc(connectionRef);

    if (!connectionSnap.exists()) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    const connection = connectionSnap.data() as TrueLayerConnection;

    if (connection.userId !== userId) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    // Fetch account details from TrueLayer
    const client = getTrueLayerClient();
    const account = await client.getAccount(connection.accessToken, accountId);
    const iban = getAccountIban(account);

    // Build API config
    const apiConfig: TrueLayerApiConfig = {
      provider: "truelayer",
      connectionId,
      accountId,
      providerId: connection.providerId,
      providerName: connection.providerName,
      providerLogo: connection.providerLogo || undefined,
      connectedAt: Timestamp.now(),
    };

    const now = Timestamp.now();

    if (sourceId) {
      // Link to existing source
      const sourceRef = doc(db, "sources", sourceId);
      const sourceSnap = await getDoc(sourceRef);

      if (!sourceSnap.exists()) {
        return NextResponse.json(
          { error: "Source not found" },
          { status: 404 }
        );
      }

      const existingSource = sourceSnap.data();
      const sourceIban = iban ? normalizeIban(iban) : existingSource.iban || "";

      await updateDoc(sourceRef, {
        type: "api",
        apiConfig,
        bankName: connection.providerName,
        ...(iban ? { iban: sourceIban } : {}),
        updatedAt: now,
      });

      // Trigger initial sync in background
      triggerInitialSync(sourceId, connection.accessToken, accountId, sourceIban, userId).catch(
        (err) => console.error("Initial sync failed:", err)
      );

      return NextResponse.json({ sourceId, linked: true });
    }

    // Create new source
    if (!name) {
      return NextResponse.json(
        { error: "name is required when creating a new source" },
        { status: 400 }
      );
    }

    const sourceData = {
      name,
      accountKind: "bank_account" as const,
      iban: iban ? normalizeIban(iban) : "",
      bic: account.account_number?.swift_bic || null,
      bankName: connection.providerName,
      currency: account.currency,
      type: "api" as const,
      apiConfig,
      isActive: true,
      userId,
      createdAt: now,
      updatedAt: now,
    };

    console.log("[TrueLayer Accounts POST] Creating source with data:", JSON.stringify(sourceData, null, 2));

    const docRef = await addDoc(collection(db, "sources"), sourceData);
    console.log("[TrueLayer Accounts POST] Source created with ID:", docRef.id);

    // Trigger initial sync in background (don't wait)
    triggerInitialSync(docRef.id, connection.accessToken, accountId, sourceData.iban, userId).catch(
      (err) => console.error("Initial sync failed:", err)
    );

    return NextResponse.json({ sourceId: docRef.id, linked: false });
  } catch (error) {
    console.error("[TrueLayer Accounts POST] Error creating/linking source:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create/link source" },
      { status: 500 }
    );
  }
}

/**
 * Trigger initial transaction sync for a newly created source
 */
async function triggerInitialSync(
  sourceId: string,
  accessToken: string,
  accountId: string,
  sourceIban: string,
  userId: string
) {
  try {
    const client = getTrueLayerClient();

    // Get transactions from last 90 days
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 90);
    const toDate = new Date();

    const transactions = await client.getTransactions(
      accessToken,
      accountId,
      fromDate.toISOString().split("T")[0],
      toDate.toISOString().split("T")[0]
    );

    if (transactions.length === 0) {
      console.log(`No transactions to import for source ${sourceId}`);
      return;
    }

    // Import transactions
    const { generateDedupeHash } = await import("@/lib/import/deduplication");
    const nowTs = Timestamp.now();

    for (const tx of transactions) {
      const isCredit = tx.transaction_type === "CREDIT";
      const amount = isCredit ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      const txDate = new Date(tx.timestamp);
      const reference = tx.meta?.provider_reference || tx.transaction_id;

      const dedupeHash = await generateDedupeHash(txDate, amount, sourceIban, reference);

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
    }

    // Update source with last sync time
    await updateDoc(doc(db, "sources", sourceId), {
      "apiConfig.lastSyncAt": nowTs,
      updatedAt: nowTs,
    });

    console.log(`Imported ${transactions.length} transactions for source ${sourceId}`);
  } catch (error) {
    console.error("Initial sync error:", error);
  }
}
