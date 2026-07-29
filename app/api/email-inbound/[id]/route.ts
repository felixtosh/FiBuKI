export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerDb } from "@/lib/firebase/config-server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import {
  getInboundEmailAddress,
  updateInboundEmailAddress,
  deleteInboundEmailAddress,
  getInboundEmailStats,
} from "@/lib/operations";

const db = getServerDb();

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/email-inbound/[id]
 * Get a single inbound email address with stats
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { id } = await params;
    const ctx = { db, userId };

    const address = await getInboundEmailAddress(ctx, id);
    if (!address) {
      return NextResponse.json(
        { error: "Address not found" },
        { status: 404 }
      );
    }

    const stats = await getInboundEmailStats(ctx, id);

    return NextResponse.json({
      address,
      stats,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[email-inbound] Error getting address:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get address" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/email-inbound/[id]
 * Update an inbound email address
 *
 * Body: { displayName?, allowedDomains?, dailyLimit?, isActive? }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { id } = await params;
    const body = await request.json();
    const { displayName, allowedDomains, dailyLimit, isActive } = body;

    const ctx = { db, userId };

    await updateInboundEmailAddress(ctx, id, {
      displayName,
      allowedDomains,
      dailyLimit,
      isActive,
    });

    const updatedAddress = await getInboundEmailAddress(ctx, id);

    return NextResponse.json({
      success: true,
      address: updatedAddress,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[email-inbound] Error updating address:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update address" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/email-inbound/[id]
 * Delete (deactivate) an inbound email address
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { id } = await params;
    const ctx = { db, userId };

    await deleteInboundEmailAddress(ctx, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[email-inbound] Error deleting address:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete address" },
      { status: 500 }
    );
  }
}
