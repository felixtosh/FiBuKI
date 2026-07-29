export const dynamic = "force-dynamic";

/**
 * Admin: Delete orphaned transactions
 *
 * Proxies to the cleanupOrphanedTransactions Cloud Function.
 * Use this route for backwards compatibility.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, isServerUserAdmin, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callCloudFunction, setAuthToken } from "@/lib/firebase/callable-server";
import {
  CleanupOrphanedTransactionsRequest,
  CleanupOrphanedTransactionsResponse,
} from "@/types/banking-sync";

export async function POST(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if admin
    const adminCheck = await isServerUserAdmin(request);

    const body = await request.json();
    const { dryRun = true, targetUserId } = body;

    // Only admins can clean up other users' transactions
    const requestData: CleanupOrphanedTransactionsRequest = {
      dryRun,
    };

    if (adminCheck && targetUserId) {
      requestData.targetUserId = targetUserId;
    }

    // Call the Cloud Function
    const result = await callCloudFunction<
      CleanupOrphanedTransactionsRequest,
      CleanupOrphanedTransactionsResponse
    >("cleanupOrphanedTransactions", requestData);

    return NextResponse.json(result);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Cleanup] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cleanup failed" },
      { status: 500 }
    );
  }
}

/**
 * GET - Preview orphaned transactions (dry run)
 */
export async function GET(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Call the Cloud Function with dryRun=true
    const result = await callCloudFunction<
      CleanupOrphanedTransactionsRequest,
      CleanupOrphanedTransactionsResponse
    >("cleanupOrphanedTransactions", {
      dryRun: true,
    });

    return NextResponse.json(result);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Cleanup] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to check orphans" },
      { status: 500 }
    );
  }
}
