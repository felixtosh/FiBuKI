export const dynamic = "force-dynamic";
export const maxDuration = 800; // the golden set runs one real chat turn after another

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, isServerUserAdmin, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { runBukiEvals } from "@/lib/agent/evals/runner";

export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const isAdmin = await isServerUserAdmin(request);
    if (!isAdmin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { category, includeWrites } = body;

    const authToken = request.headers.get("Authorization")?.replace("Bearer ", "") || "";

    // Derive base URL from the incoming request
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const host = request.headers.get("host") || "localhost:3000";
    const baseUrl = `${proto}://${host}`;

    // BuKI's golden set, scored with the rubric (docs/buki-rubric.md).
    const result = await runBukiEvals({
      baseUrl,
      authToken,
      userId,
      category: category && category !== "all" ? category : undefined,
      includeWrites: includeWrites === true,
    });

    // Serialize dates for JSON response
    return NextResponse.json({
      ...result,
      startedAt: result.startedAt.toISOString(),
      completedAt: result.completedAt.toISOString(),
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[AdminTests] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Test run failed" },
      { status: 500 }
    );
  }
}
