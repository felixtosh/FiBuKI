export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerDb } from "@/lib/firebase/config-server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { regenerateInboundEmailAddress } from "@/lib/operations";

const db = getServerDb();

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/email-inbound/[id]/regenerate
 * Generate a new email address (deactivates the old one)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { id } = await params;
    const ctx = { db, userId };

    const result = await regenerateInboundEmailAddress(ctx, id);

    return NextResponse.json({
      success: true,
      id: result.id,
      email: result.email,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[email-inbound] Error regenerating address:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to regenerate address" },
      { status: 500 }
    );
  }
}
