export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";

// Types for the API (matches scoreAttachmentMatchCallable)
interface AttachmentInput {
  key: string;
  filename: string;
  mimeType: string;
  // Email context
  emailSubject?: string | null;
  emailFrom?: string | null;
  emailSnippet?: string | null;
  emailBodyText?: string | null;
  emailDate?: string | null; // ISO string
  integrationId?: string | null;
  // File extracted data
  fileExtractedAmount?: number | null;
  fileExtractedDate?: string | null; // ISO string
  fileExtractedPartner?: string | null;
  filePartnerId?: string | null;
  // Email classification
  classification?: {
    hasPdfAttachment?: boolean;
    possibleMailInvoice?: boolean;
    possibleInvoiceLink?: boolean;
    confidence?: number;
  } | null;
}

interface TransactionInput {
  amount?: number | null;
  date?: string | null; // ISO string
  name?: string | null;
  reference?: string | null;
  partner?: string | null;
  partnerId?: string | null;
}

interface PartnerInput {
  name?: string | null;
  emailDomains?: string[] | null;
  fileSourcePatterns?: Array<{
    sourceType: string;
    integrationId?: string;
  }> | null;
}

interface ScoreFilesRequest {
  attachments: AttachmentInput[];
  transaction: TransactionInput;
  partner?: PartnerInput | null;
}

// Server-side callable response type
interface ScoreAttachmentResponse {
  scores: Array<{
    key: string;
    score: number;
    label: "Strong" | "Likely" | null;
    reasons: string[];
  }>;
}

/**
 * POST /api/matching/score-files
 *
 * Score attachments/files against a transaction using server-side scoring.
 * Proxies to scoreAttachmentMatchCallable Firebase function for consistency.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get auth token from header to pass to Firebase callable
    const authHeader = request.headers.get("Authorization");
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : undefined;

    const body: ScoreFilesRequest = await request.json();
    const { attachments, transaction, partner } = body;

    if (!attachments || !Array.isArray(attachments)) {
      return NextResponse.json(
        { error: "attachments array is required" },
        { status: 400 }
      );
    }

    if (!transaction) {
      return NextResponse.json(
        { error: "transaction is required" },
        { status: 400 }
      );
    }

    // Call server-side scoring function (ensures consistency with all scoring)
    const response = await callFirebaseFunction<ScoreFilesRequest, ScoreAttachmentResponse>(
      "scoreAttachmentMatchCallable",
      {
        attachments: attachments.map((att) => ({
          key: att.key,
          filename: att.filename,
          mimeType: att.mimeType,
          emailSubject: att.emailSubject,
          emailFrom: att.emailFrom,
          emailSnippet: att.emailSnippet,
          emailBodyText: att.emailBodyText,
          emailDate: att.emailDate,
          integrationId: att.integrationId,
          fileExtractedAmount: att.fileExtractedAmount,
          fileExtractedDate: att.fileExtractedDate,
          fileExtractedPartner: att.fileExtractedPartner,
          filePartnerId: att.filePartnerId,
          classification: att.classification,
        })),
        transaction: {
          amount: transaction.amount,
          date: transaction.date,
          name: transaction.name,
          reference: transaction.reference,
          partner: transaction.partner,
          partnerId: transaction.partnerId,
        },
        partner: partner ? {
          name: partner.name,
          emailDomains: partner.emailDomains,
          fileSourcePatterns: partner.fileSourcePatterns,
        } : null,
      },
      authToken || undefined
    );

    return NextResponse.json({ scores: response.scores });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[API] score-files error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
