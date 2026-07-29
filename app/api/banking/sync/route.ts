export const dynamic = "force-dynamic";

/**
 * Banking Sync API
 *
 * This API route proxies to the syncBankTransactions Cloud Function.
 * The Cloud Function contains all sync logic including:
 * - Token refresh
 * - Orphan detection and reassignment
 * - Deduplication across user (not just source)
 * - Year change handling
 * - Import record creation
 *
 * Use this route for backwards compatibility. New code should call
 * the Cloud Function directly via callFunction("syncBankTransactions").
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callCloudFunction, setAuthToken } from "@/lib/firebase/callable-server";
import {
  SyncBankTransactionsRequest,
  SyncBankTransactionsResponse,
} from "@/types/banking-sync";

/**
 * POST /api/banking/sync
 * Trigger manual transaction sync for a finAPI source
 *
 * Proxies to syncBankTransactions Cloud Function
 */
export async function POST(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { sourceId, fromYear } = body;

    if (!sourceId) {
      return NextResponse.json(
        { error: "sourceId is required" },
        { status: 400 }
      );
    }

    // Call the Cloud Function
    const result = await callCloudFunction<
      SyncBankTransactionsRequest,
      SyncBankTransactionsResponse
    >("syncBankTransactions", {
      sourceId,
      fromYear,
    });

    return NextResponse.json(result);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Banking Sync] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync transactions" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/banking/sync?sourceId={id}
 * Get sync status for a source
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sourceId = request.nextUrl.searchParams.get("sourceId");

    if (!sourceId) {
      return NextResponse.json(
        { error: "sourceId is required" },
        { status: 400 }
      );
    }

    const db = getAdminDb();

    // Get source
    const sourceDoc = await db.collection("sources").doc(sourceId).get();
    if (!sourceDoc.exists) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const source = sourceDoc.data()!;
    if (source.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (source.type !== "api" || !source.apiConfig) {
      return NextResponse.json(
        { error: "Source is not an API-connected account" },
        { status: 400 }
      );
    }

    const config = source.apiConfig;
    const expiresAt = config.expiresAt?.toDate?.() || (config.expiresAt ? new Date(config.expiresAt) : null);
    const lastSyncAt = config.lastSyncAt?.toDate?.() || (config.lastSyncAt ? new Date(config.lastSyncAt) : null);
    const now = new Date();
    const daysRemaining = expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : null;

    return NextResponse.json({
      status: {
        lastSyncAt: lastSyncAt?.toISOString() || null,
        lastSyncError: config.lastSyncError || null,
        needsReauth: expiresAt ? expiresAt < now : false,
        reauthExpiresAt: expiresAt?.toISOString() || null,
        reauthDaysRemaining: daysRemaining,
        providerId: config.provider,
      },
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Banking Sync] Error getting status:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get sync status" },
      { status: 500 }
    );
  }
}
