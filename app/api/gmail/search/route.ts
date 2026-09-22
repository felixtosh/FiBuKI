export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import type { MailSearchLimitation } from "@/functions/src/mail/provider";

// Types matching the callable response
interface GmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  isLikelyReceipt: boolean;
  existingFileId?: string | null;
}

interface EmailClassification {
  hasPdfAttachment: boolean;
  possibleMailInvoice: boolean;
  possibleInvoiceLink: boolean;
  confidence: number;
  matchedKeywords: string[];
}

interface GmailMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string | null;
  date: string;
  snippet: string;
  bodyText: string | null;
  attachments: GmailAttachment[];
  classification?: EmailClassification;
}

interface SearchGmailResponse {
  messages: GmailMessage[];
  nextPageToken?: string;
  totalEstimate?: number;
  /** Constraints the mailbox could not execute as asked (#240). */
  limitations?: MailSearchLimitation[];
}

/**
 * POST /api/gmail/search
 * Search a connected mailbox for messages with attachments
 *
 * Proxies to searchGmailCallable (single source of truth)
 *
 * The search is stated in provider-neutral terms (#240) — keywords, a sender,
 * filename fragments, a date window. `query` is the Gmail-only escape hatch the
 * automation callers still use; the attach path does not send it.
 *
 * Body: {
 *   integrationId: string;
 *   keywords?: string[];
 *   from?: string;
 *   filenames?: string[];
 *   query?: string; // raw Gmail query, Gmail integrations only
 *   dateFrom?: string; // ISO date
 *   dateTo?: string; // ISO date
 *   hasAttachments?: boolean;
 *   limit?: number;
 *   pageToken?: string;
 *   expandThreads?: boolean;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      integrationId,
      query,
      keywords,
      filenames,
      dateFrom,
      dateTo,
      from,
      hasAttachments = true,
      limit = 20,
      pageToken,
      expandThreads = false,
    } = body;

    console.log("[Gmail Search] Request", {
      integrationId,
      query,
      keywords,
      filenames,
      dateFrom,
      dateTo,
      from,
      hasAttachments,
      limit,
      pageToken,
      expandThreads,
    });

    if (!integrationId) {
      return NextResponse.json(
        { error: "integrationId is required" },
        { status: 400 }
      );
    }

    // Get auth token from request to pass to callable
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

    // Call the Firebase callable (single source of truth)
    const result = await callFirebaseFunction<
      {
        integrationId: string;
        query?: string;
        keywords?: string[];
        filenames?: string[];
        dateFrom?: string;
        dateTo?: string;
        from?: string;
        hasAttachments?: boolean;
        limit?: number;
        pageToken?: string;
        expandThreads?: boolean;
      },
      SearchGmailResponse
    >(
      "searchGmailCallable",
      {
        integrationId,
        query,
        keywords,
        filenames,
        dateFrom,
        dateTo,
        from,
        hasAttachments,
        limit,
        pageToken,
        expandThreads,
      },
      token || undefined
    );

    console.log("[Gmail Search] Response", {
      integrationId,
      messageCount: result?.messages?.length || 0,
      totalEstimate: result?.totalEstimate,
    });

    return NextResponse.json({
      success: true,
      messages: result?.messages || [],
      nextPageToken: result?.nextPageToken,
      totalEstimate: result?.totalEstimate,
      limitations: result?.limitations,
    });
  } catch (error) {
    console.error("Error searching Gmail:", error);

    // Parse error from callable
    const errorMessage = error instanceof Error ? error.message : "Failed to search Gmail";

    // Check for auth-related errors
    if (errorMessage.includes("unauthenticated") || errorMessage.includes("AUTH_EXPIRED")) {
      return NextResponse.json(
        {
          error: "Authentication expired. Please reconnect Gmail.",
          code: "AUTH_EXPIRED",
        },
        { status: 403 }
      );
    }

    if (errorMessage.includes("Re-authentication required") || errorMessage.includes("REAUTH")) {
      return NextResponse.json(
        {
          error: "Re-authentication required",
          code: "REAUTH_REQUIRED",
        },
        { status: 403 }
      );
    }

    if (errorMessage.includes("Tokens not found") || errorMessage.includes("TOKENS")) {
      return NextResponse.json(
        {
          error: "Tokens not found. Please reconnect Gmail.",
          code: "TOKENS_MISSING",
        },
        { status: 403 }
      );
    }

    if (errorMessage.includes("expired")) {
      return NextResponse.json(
        {
          error: "Access token expired. Please reconnect Gmail.",
          code: "TOKEN_EXPIRED",
        },
        { status: 403 }
      );
    }

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
