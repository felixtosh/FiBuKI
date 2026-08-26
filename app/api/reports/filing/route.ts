export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

/**
 * POST /api/reports/filing
 *
 * Prepare the UVA filing record for a period (#85): the figures plus the
 * Vorsteuer trace, the exceptions with their statutory basis, the declared
 * open items and the reconciliation against the period's kept baseline.
 *
 * Proxies to prepareUvaFiling, which is where the record is kept. Nothing here
 * submits anything — recording a handover states that a human sent the packet,
 * and FinanzOnline submission remains the separate submitUvaToFinanzOnline path.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : undefined;

    const body = await request.json();
    if (!body?.period) {
      return NextResponse.json({ error: "period is required" }, { status: 400 });
    }

    const response = await callFirebaseFunction<typeof body, unknown>(
      "prepareUvaFiling",
      body,
      authToken
    );

    return NextResponse.json(response);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] reports/filing error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
