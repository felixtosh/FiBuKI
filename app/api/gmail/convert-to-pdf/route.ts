export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, getAdminBucket, getFirebaseStorageDownloadUrl } from "@/lib/firebase/admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { createHash, randomUUID } from "crypto";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { GmailResolutionError, resolveGmailIntegration } from "@/lib/gmail/resolve-integration";

interface ConvertHtmlToPdfResponse {
  success: boolean;
  pdfBase64: string;
  pageCount: number;
}

const db = getAdminDb();

const FILES_COLLECTION = "files";
const TRANSACTIONS_COLLECTION = "transactions";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

function parseFromHeader(fromValue?: string | null): { email?: string; name?: string } {
  if (!fromValue) return {};
  // Cap length: a legitimate From header is far below 1 KB, and the cap bounds regex time
  const header = fromValue.slice(0, 1024);
  const angle = header.match(/<([^<>]*)>/);
  const candidate = (angle ? angle[1] : header).trim();
  const emailMatch = candidate.match(/[^<>@\s"]+@[^<>@\s".]+(?:\.[^<>@\s".]+)+/);
  if (!emailMatch) return {};
  const name = angle
    ? header.slice(0, angle.index).replace(/"/g, "").trim() || undefined
    : undefined;
  return { email: emailMatch[0], name };
}

function extractDomain(email?: string | null): string | null {
  if (!email) return null;
  const match = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : null;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload?: GmailMessagePart;
}

/**
 * POST /api/gmail/convert-to-pdf
 * Convert email HTML to PDF and save as a file
 *
 * Body: {
 *   messageId: string;
 *   integrationId?: string; // optional; if absent, resolved from messageId
 *   transactionId?: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const {
      integrationId,
      messageId,
      transactionId,
      searchPattern,
      gmailMessageFrom,
      gmailMessageFromName,
    } = body;

    if (!messageId) {
      return NextResponse.json(
        { error: "messageId is required" },
        { status: 400 }
      );
    }

    let ctx;
    try {
      ctx = await resolveGmailIntegration({ integrationId, messageId }, userId);
    } catch (err) {
      if (err instanceof GmailResolutionError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      }
      throw err;
    }
    const integration = ctx.integration;

    // Fetch the message
    const messageResponse = await fetch(
      `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      {
        headers: {
          Authorization: `Bearer ${ctx.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!messageResponse.ok) {
      if (messageResponse.status === 401) {
        return NextResponse.json(
          { error: "Authentication expired", code: "AUTH_EXPIRED" },
          { status: 403 }
        );
      }
      throw new Error(`Gmail API error: ${messageResponse.status}`);
    }

    const message: GmailMessage = await messageResponse.json();

    // Extract email content
    const headers = message.payload?.headers || [];
    const getHeader = (name: string): string => {
      const header = headers.find(
        (h) => h.name.toLowerCase() === name.toLowerCase()
      );
      return header?.value || "";
    };

    const subject = getHeader("Subject");
    const from = getHeader("From");
    const dateStr = getHeader("Date");
    const emailDate = new Date(dateStr);
    const parsedFrom = parseFromHeader(gmailMessageFrom || from);
    const senderEmail = parsedFrom.email;
    const senderName = gmailMessageFromName || parsedFrom.name;
    const senderDomain = extractDomain(senderEmail);

    // Extract body content
    const { htmlBody, textBody } = extractBodyContent(message.payload);

    // Get auth token from request headers to pass to Firebase function
    const authToken = request.headers.get("Authorization") || "";

    // Convert to PDF
    const html = htmlBody || textBody || message.snippet || "";
    const pdfResult = await convertHtmlToPdf(html, authToken, {
      subject,
      from,
      date: emailDate,
    });

    // Calculate file hash for deduplication
    const fileHash = createHash("sha256").update(pdfResult.pdfBuffer).digest("hex");

    // Generate filename from subject
    const sanitizedSubject = (subject || "email")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 50);
    const timestamp = Date.now();
    const filename = `${sanitizedSubject}_${timestamp}.pdf`;

    // Upload to Firebase Storage using Admin SDK
    const storagePath = `files/${userId}/${filename}`;
    const bucket = getAdminBucket();
    const file = bucket.file(storagePath);

    // Generate a download token (same as client SDK's getDownloadURL)
    const downloadToken = randomUUID();

    await file.save(pdfResult.pdfBuffer, {
      metadata: {
        contentType: "application/pdf",
        contentDisposition: "inline",
        metadata: {
          originalName: filename,
          gmailMessageId: messageId,
          gmailIntegrationId: ctx.integrationId,
          convertedFromEmail: "true",
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });

    // Construct Firebase Storage download URL (permanent, like client SDK's getDownloadURL)
    const downloadUrl = getFirebaseStorageDownloadUrl(bucket.name, storagePath, downloadToken);

    // Create file document
    const now = Timestamp.now();
    const fileData = {
      userId,
      fileName: filename,
      fileType: "application/pdf",
      fileSize: pdfResult.pdfBuffer.length,
      storagePath,
      downloadUrl,
      fileHash,
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
      // Gmail-specific fields
      sourceType: "gmail_html_invoice" as const,
      sourceSearchPattern: searchPattern || null,
      sourceResultType: "gmail_html_invoice",
      gmailMessageId: messageId,
      gmailThreadId: message.threadId,
      gmailIntegrationId: integrationId,
      gmailIntegrationEmail: integration.email || null,
      gmailSubject: subject || null,
      gmailSenderEmail: senderEmail || null,
      gmailSenderName: senderName || null,
      gmailSenderDomain: senderDomain || null,
      // Extraction will happen via Cloud Function trigger
      extractionComplete: false,
      transactionIds: transactionId ? [transactionId] : [],
    };

    const fileRef = await db.collection(FILES_COLLECTION).add(fileData);
    const fileId = fileRef.id;

    // If transactionId provided, connect file to transaction
    if (transactionId) {
      await db.collection(TRANSACTIONS_COLLECTION).doc(transactionId).update({
        fileIds: FieldValue.arrayUnion(fileId),
        isComplete: true,
        updatedAt: now,
      });

      // Also create file connection document
      await db.collection("fileConnections").add({
        fileId,
        transactionId,
        userId,
        connectionType: "gmail_html_conversion",
        createdAt: now,
      });
    }

    return NextResponse.json({
      success: true,
      fileId,
      fileName: filename,
      downloadUrl,
      pageCount: pdfResult.pageCount,
      connectedToTransaction: !!transactionId,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[convert-to-pdf] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to convert email to PDF" },
      { status: 500 }
    );
  }
}

/**
 * Extract HTML and text body from Gmail message payload
 */
function extractBodyContent(payload: GmailMessagePart | undefined): {
  htmlBody: string;
  textBody: string;
} {
  let htmlBody = "";
  let textBody = "";

  if (!payload) return { htmlBody, textBody };

  // Check direct body
  if (payload.body?.data) {
    const decoded = Buffer.from(
      payload.body.data.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");

    if (payload.mimeType === "text/html") {
      htmlBody = decoded;
    } else if (payload.mimeType === "text/plain") {
      textBody = decoded;
    }
  }

  // Check child parts recursively
  if (payload.parts) {
    for (const part of payload.parts) {
      const { htmlBody: partHtml, textBody: partText } = extractBodyContent(part);
      if (partHtml && !htmlBody) htmlBody = partHtml;
      if (partText && !textBody) textBody = partText;
    }
  }

  return { htmlBody, textBody };
}

/**
 * Convert HTML to PDF using Cloud Function (Puppeteer runs in Cloud Functions)
 */
async function convertHtmlToPdf(
  html: string,
  authToken: string,
  metadata?: {
    subject?: string;
    from?: string;
    date?: Date;
  }
): Promise<{ pdfBuffer: Buffer; pageCount: number }> {
  const response = await callFirebaseFunction<
    {
      html: string;
      metadata?: {
        subject?: string;
        from?: string;
        date?: string;
      };
    },
    ConvertHtmlToPdfResponse
  >(
    "convertHtmlToPdfCallable",
    {
      html,
      metadata: metadata
        ? {
            subject: metadata.subject,
            from: metadata.from,
            date: metadata.date?.toISOString(),
          }
        : undefined,
    },
    authToken
  );

  return {
    pdfBuffer: Buffer.from(response.pdfBase64, "base64"),
    pageCount: response.pageCount,
  };
}
