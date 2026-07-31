export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — tests run sequentially against /api/chat

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, isServerUserAdmin, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { runChatTests } from "@/lib/testing/chat-test-runner";

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
    const { category, tags } = body;

    const authToken = request.headers.get("Authorization")?.replace("Bearer ", "") || "";

    // Derive base URL from the incoming request
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const host = request.headers.get("host") || "localhost:3000";
    const baseUrl = `${proto}://${host}`;

    const result = await runChatTests({
      baseUrl,
      authToken,
      userId,
      category: category || undefined,
      tags: tags || undefined,
      logToLangfuse: true,
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
