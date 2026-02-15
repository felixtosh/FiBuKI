export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

interface ConvertHtmlToPdfResponse {
  success: boolean;
  pdfBase64: string;
  pageCount: number;
}

/**
 * POST /api/browser/convert-html
 * Converts page HTML to PDF via the convertHtmlToPdf Cloud Function.
 * Used by the browser extension to capture HTML invoice pages as PDFs.
 *
 * Body: { html: string, pageUrl: string, pageTitle: string }
 * Returns: PDF binary (application/pdf)
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { html, pageUrl, pageTitle } = await request.json();

    if (!html) {
      return new Response(JSON.stringify({ error: "html is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get auth token to pass through to Cloud Function
    const authToken = request.headers.get("Authorization") || "";

    let hostname = "";
    try {
      hostname = new URL(pageUrl).hostname;
    } catch {
      hostname = pageUrl || "unknown";
    }

    const result = await callFirebaseFunction<
      {
        html: string;
        metadata?: { subject?: string; from?: string; date?: string };
      },
      ConvertHtmlToPdfResponse
    >(
      "convertHtmlToPdfCallable",
      {
        html,
        metadata: {
          subject: pageTitle || undefined,
          from: hostname,
          date: new Date().toISOString(),
        },
      },
      authToken
    );

    const pdfBuffer = Buffer.from(result.pdfBase64, "base64");
    return new Response(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdfBuffer.length),
      },
    });
  } catch (error) {
    console.error("[convert-html] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to convert HTML to PDF",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
