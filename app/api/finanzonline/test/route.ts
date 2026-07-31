export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

/**
 * POST /api/finanzonline/test
 *
 * Test FinanzOnline WebService connection with stored credentials.
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

    const response = await callFirebaseFunction<
      Record<string, never>,
      { success: boolean; error?: string }
    >("testFinanzOnlineConnection", {}, authToken);

    return NextResponse.json(response);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] finanzonline/test error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
