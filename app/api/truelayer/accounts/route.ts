export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { getTrueLayerClient, getAccountIban } from "@/lib/truelayer";
import { importTrueLayerTransactions } from "@/lib/truelayer/import-transactions";
import type { TrueLayerConnection, TrueLayerApiConfig } from "@/types/truelayer";
import { normalizeIban } from "@/lib/import/deduplication";
import { getAdminDb } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback, isServerUserAdmin, unauthorizedResponse } from "@/lib/auth/get-server-user";

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
}

// Reads and writes go through the server's Admin SDK (#813): a route has no
// signed-in User for the client SDK to authenticate as.
const CONNECTIONS_COLLECTION = "truelayerConnections";

/** The caller's TrueLayer connection, or null when it is missing or not theirs. */
async function ownConnection(connectionId: string, userId: string): Promise<TrueLayerConnection | null> {
  const snap = await getAdminDb().collection(CONNECTIONS_COLLECTION).doc(connectionId).get();
  if (!snap.exists) return null;
  const connection = snap.data() as unknown as TrueLayerConnection;
  return connection.userId === userId ? connection : null;
}

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

    // Not yours answers like not found.
    const connection = await ownConnection(connectionId, userId);
    if (!connection) {
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
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
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

    // Not yours answers like not found.
    const connection = await ownConnection(connectionId, userId);
    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }

    // Fetch account details from TrueLayer
    const client = getTrueLayerClient();
    const account = await client.getAccount(connection.accessToken, accountId);
    const iban = getAccountIban(account);

    // Build API config. A bank without a logo has no providerLogo field: the
    // SDK refuses an undefined value unless told to ignore it.
    // The type names the client SDK's Timestamp; the server stores the Admin SDK's.
    const apiConfig: Omit<TrueLayerApiConfig, "connectedAt" | "lastSyncAt"> & { connectedAt: Timestamp } = {
      provider: "truelayer",
      connectionId,
      accountId,
      providerId: connection.providerId,
      providerName: connection.providerName,
      ...(connection.providerLogo ? { providerLogo: connection.providerLogo } : {}),
      connectedAt: Timestamp.now(),
    };
    const isAdmin = await isServerUserAdmin(request);

    const now = Timestamp.now();
    const db = getAdminDb();

    if (sourceId) {
      // Link to existing source
      const sourceRef = db.collection("sources").doc(sourceId);
      const sourceSnap = await sourceRef.get();

      if (!sourceSnap.exists) {
        return NextResponse.json(
          { error: "Source not found" },
          { status: 404 }
        );
      }

      const existingSource = sourceSnap.data()!;

      // Linking rewrites the source's type, apiConfig and IBAN and imports
      // into it: it must be the caller's. Not yours answers like not found.
      if (existingSource.userId !== userId) {
        return NextResponse.json(
          { error: "Source not found" },
          { status: 404 }
        );
      }
      const sourceIban = iban ? normalizeIban(iban) : existingSource.iban || "";

      await sourceRef.update({
        type: "api",
        apiConfig,
        bankName: connection.providerName,
        ...(iban ? { iban: sourceIban } : {}),
        updatedAt: now,
      });

      // Trigger initial sync in background
      triggerInitialSync(sourceId, connection.accessToken, accountId, sourceIban, userId, isAdmin).catch(
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

    const docRef = await db.collection("sources").add(sourceData);
    console.log("[TrueLayer Accounts POST] Source created with ID:", docRef.id);

    // Trigger initial sync in background (don't wait)
    triggerInitialSync(docRef.id, connection.accessToken, accountId, sourceData.iban, userId, isAdmin).catch(
      (err) => console.error("Initial sync failed:", err)
    );

    return NextResponse.json({ sourceId: docRef.id, linked: false });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
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
  userId: string,
  isAdmin: boolean
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
      console.log(`No transactions to import for source ${sanitizeForLog(sourceId)}`);
      return;
    }

    // The same write as a later sync, so that sync reads these lines the same way.
    const { imported } = await importTrueLayerTransactions(getAdminDb(), {
      userId,
      sourceId,
      sourceIdentifier: sourceIban,
      transactions,
      isAdmin,
    });

    console.log(`Imported ${imported} of ${transactions.length} transactions for source ${sanitizeForLog(sourceId)}`);
  } catch (error) {
    console.error("Initial sync error:", error);
  }
}
