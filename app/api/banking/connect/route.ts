export const dynamic = "force-dynamic";
/**
 * Unified Banking Connection API
 *
 * Creates bank connections through configured provider.
 * Proxies to initiateBankConnection Cloud Function which has finAPI secrets.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { callCloudFunction, setAuthToken } from "@/lib/firebase/callable-server";

interface InitiateBankConnectionRequest {
  institutionId: string;
  redirectUrl?: string;
  maxHistoryDays?: number;
  language?: string;
  linkToSourceId?: string;
}

interface InitiateBankConnectionResponse {
  success: boolean;
  connectionId: string;
  authUrl: string;
  expiresAt: string;
}

export async function POST(request: NextRequest) {
  // Set auth token for Cloud Function calls
  setAuthToken(request.headers.get("Authorization"));

  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { providerId, institutionId, sourceId, maxHistoryDays, language } = body;

    // Validate required fields
    if (!institutionId) {
      return NextResponse.json(
        { error: "Institution ID is required" },
        { status: 400 }
      );
    }

    // Only finAPI is supported for now
    if (providerId && providerId !== "finapi") {
      return NextResponse.json(
        { error: `Unknown provider: ${providerId}` },
        { status: 400 }
      );
    }

    // Get redirect URL for callback
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const redirectUrl = `${baseUrl}/api/finapi/callback`;

    // Call Cloud Function which has finAPI secrets
    const result = await callCloudFunction<
      InitiateBankConnectionRequest,
      InitiateBankConnectionResponse
    >("initiateBankConnection", {
      institutionId,
      redirectUrl,
      maxHistoryDays,
      language,
      linkToSourceId: sourceId || undefined,
    });

    return NextResponse.json({
      connectionId: result.connectionId,
      authUrl: result.authUrl,
      expiresAt: result.expiresAt,
      provider: "finapi",
    });
  } catch (error) {
    console.error("[Banking Connect API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create connection" },
      { status: 500 }
    );
  }
}
