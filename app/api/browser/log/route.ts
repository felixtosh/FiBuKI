export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  addDoc,
  collection,
  Timestamp,
  query,
  orderBy,
  limit as limitQuery,
  getDocs,
  where,
} from "firebase/firestore";
import { getServerDb } from "@/lib/firebase/config-server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

const db = getServerDb();
const DEBUG_LOGS_COLLECTION = "browser_debug_logs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

interface DebugLogData {
  runId?: string;
  url?: string;
  type?: string;
  pageSnapshot?: {
    title?: string;
    bodyHTML?: string;
    tables?: number;
    buttons?: Array<{
      text?: string;
      ariaLabel?: string;
      hasPopup?: string;
    }>;
    menus?: number;
  };
  detectedElements?: Array<Record<string, unknown>>;
  fetchAttempts?: Array<{
    url: string;
    status?: number;
    contentType?: string;
    bodyPreview?: string;
    error?: string;
  }>;
  extractorLogs?: string[];
  snapshot?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * POST /api/browser/log
 * Store debug data from the browser extension for analysis.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const data: DebugLogData = await request.json();

    const now = Timestamp.now();
    const logDoc = {
      userId,
      createdAt: now,
      runId: data.runId || null,
      url: data.url || null,
      type: data.type || "debug",
      // Truncate bodyHTML if present
      pageSnapshot: data.pageSnapshot
        ? {
            ...data.pageSnapshot,
            bodyHTML: data.pageSnapshot.bodyHTML?.slice(0, 50000),
          }
        : data.snapshot || null,
      detectedElements: data.detectedElements || null,
      fetchAttempts: data.fetchAttempts || null,
      extractorLogs: data.extractorLogs || null,
    };

    const docRef = await addDoc(collection(db, DEBUG_LOGS_COLLECTION), logDoc);

    return NextResponse.json(
      { ok: true, logId: docRef.id },
      { headers: corsHeaders }
    );
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Browser debug log failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Log failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}

/**
 * GET /api/browser/log
 * Retrieve recent debug logs for analysis.
 * Query params:
 * - limit: number (default 10, max 50)
 * - url: string (filter by URL pattern)
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const { searchParams } = new URL(request.url);
    const limitParam = parseInt(searchParams.get("limit") || "10", 10);
    const urlFilter = searchParams.get("url");

    const maxLimit = Math.min(Math.max(1, limitParam), 50);

    const constraints: Parameters<typeof query>[1][] = [
      where("userId", "==", userId),
      orderBy("createdAt", "desc"),
      limitQuery(maxLimit),
    ];

    const q = query(collection(db, DEBUG_LOGS_COLLECTION), ...constraints);
    const snapshot = await getDocs(q);

    let logs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Client-side URL filtering if specified
    if (urlFilter) {
      const filterLower = urlFilter.toLowerCase();
      logs = logs.filter((log) => {
        const logUrl = (log as { url?: string }).url;
        return logUrl && logUrl.toLowerCase().includes(filterLower);
      });
    }

    return NextResponse.json(
      { ok: true, logs, count: logs.length },
      { headers: corsHeaders }
    );
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Browser debug log GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Fetch failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
