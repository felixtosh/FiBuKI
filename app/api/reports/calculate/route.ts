export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

interface ReportPeriod {
  year: number;
  period: number;
  type: "monthly" | "quarterly";
}

interface CalculateRequest {
  period: ReportPeriod;
}

/**
 * POST /api/reports/calculate
 *
 * Server-side UVA calculation (fork #64, D4): proxies to the api
 * container's calculateUva callable, which reads the period's
 * transactions AND their connected receipts. Replaces the old
 * browser-side calculation that assumed 20% VAT on everything.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : undefined;

    const body: CalculateRequest = await request.json();
    if (!body.period) {
      return NextResponse.json({ error: "period is required" }, { status: 400 });
    }

    const response = await callFirebaseFunction<CalculateRequest, unknown>(
      "calculateUva",
      { period: body.period },
      authToken
    );

    return NextResponse.json(response);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] reports/calculate error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
