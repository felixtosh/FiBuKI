export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerDb } from "@/lib/firebase/config-server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import {
  getInboundEmailAddress,
  listInboundEmailLogs,
} from "@/lib/operations";

const db = getServerDb();

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/email-inbound/[id]/logs
 * List email logs for an inbound address
 *
 * Query params: limit (default 50)
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { id } = await params;
    const limitParam = request.nextUrl.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 50;

    const ctx = { db, userId };

    // Verify address exists and belongs to user
    const address = await getInboundEmailAddress(ctx, id);
    if (!address) {
      return NextResponse.json(
        { error: "Address not found" },
        { status: 404 }
      );
    }

    const logs = await listInboundEmailLogs(ctx, id, limit);

    return NextResponse.json({ logs });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[email-inbound] Error listing logs:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list logs" },
      { status: 500 }
    );
  }
}
