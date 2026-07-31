export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

/**
 * POST /api/finanzonline/credentials
 *
 * Save FinanzOnline WebService credentials.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : undefined;

    const body = await request.json();
    const { teilnehmerId, benutzerId, pin } = body;

    // Validate required fields
    if (!teilnehmerId || !benutzerId || !pin) {
      return NextResponse.json(
        { error: "teilnehmerId, benutzerId, and pin are required" },
        { status: 400 }
      );
    }

    const response = await callFirebaseFunction<
      { teilnehmerId: string; benutzerId: string; pin: string },
      { success: boolean }
    >(
      "saveFinanzOnlineCredentials",
      { teilnehmerId, benutzerId, pin },
      authToken
    );

    return NextResponse.json(response);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] finanzonline/credentials POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/finanzonline/credentials
 *
 * Delete FinanzOnline WebService credentials.
 */
export async function DELETE(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : undefined;

    const response = await callFirebaseFunction<
      Record<string, never>,
      { success: boolean }
    >("deleteFinanzOnlineCredentials", {}, authToken);

    return NextResponse.json(response);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] finanzonline/credentials DELETE error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
