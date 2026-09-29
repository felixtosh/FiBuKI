export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb, getAdminBucket, getFirebaseStorageDownloadUrl } from "@/lib/firebase/admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { createHash, randomUUID } from "crypto";
import { createFileRecord } from "@/functions/src/files/createFileRecord";
import { callFirebaseFunction } from "@/lib/api/firebase-callable";
import { GmailResolutionError, resolveGmailIntegration } from "@/lib/gmail/resolve-integration";
import {
  fetchProviderBody,
  ownedIntegrationProvider,
  providerErrorResponse,
  readsThroughProviderFactory,
} from "@/lib/mail/provider-attach";

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

    // Get auth token from request headers to pass to Firebase function
    const authToken = request.headers.get("Authorization") || "";

    // Every mailbox but Gmail is read through the provider factory (#245).
    // The conversion and the File written afterwards are the same for both.
    const provider = await ownedIntegrationProvider(integrationId, userId);
    const content =
      integrationId && readsThroughProviderFactory(provider)
        ? await readProviderMessage(authToken, integrationId, messageId)
        : await readGmailMessage(integrationId, messageId, userId);
    if ("response" in content) return content.response;

    const { subject, from, emailDate, htmlBody, textBody, snippet, threadId } = content;
    const parsedFrom = parseFromHeader(gmailMessageFrom || from);
    const senderEmail = parsedFrom.email;
    const senderName = gmailMessageFromName || parsedFrom.name;
    const senderDomain = extractDomain(senderEmail);

    // Convert to PDF
    const html = htmlBody || textBody || snippet || "";
    const pdfResult = await convertHtmlToPdf(html, authToken, {
      subject,
      from,
      date: emailDate,
    });

    const contentHash = createHash("sha256").update(pdfResult.pdfBuffer).digest("hex");

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
          mailMessageId: messageId,
          gmailIntegrationId: content.integrationId,
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
      contentHash,
      uploadedAt: now,
      createdAt: now,
      updatedAt: now,
      // Gmail-specific fields
      sourceType: "gmail_html_invoice" as const,
      sourceSearchPattern: searchPattern || null,
      sourceResultType: "gmail_html_invoice",
      mailMessageId: messageId,
      gmailThreadId: threadId,
      gmailIntegrationId: integrationId,
      gmailIntegrationEmail: content.integrationEmail,
      gmailSubject: subject || null,
      gmailSenderEmail: senderEmail || null,
      gmailSenderName: senderName || null,
      gmailSenderDomain: senderDomain || null,
      // Extraction will happen via Cloud Function trigger
      extractionComplete: false,
      transactionIds: transactionId ? [transactionId] : [],
    };

    const { fileId, duplicate } = await createFileRecord(db, fileData);
    if (duplicate && transactionId) {
      await db.collection(FILES_COLLECTION).doc(fileId).update({
        transactionIds: FieldValue.arrayUnion(transactionId),
        updatedAt: now,
      });
    }

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

/** What the PDF is made of, whichever mailbox it came from. */
interface MessageContent {
  subject: string;
  from: string;
  emailDate: Date;
  htmlBody: string;
  textBody: string;
  snippet: string;
  threadId: string;
  integrationId: string;
  integrationEmail: string | null;
}

/** A mailbox read through the provider factory (#245). */
async function readProviderMessage(
  authToken: string,
  integrationId: string,
  messageId: string
): Promise<MessageContent | { response: NextResponse }> {
  try {
    const content = await fetchProviderBody(authToken, { integrationId, messageId });
    return {
      subject: content.subject,
      from: content.from,
      emailDate: new Date(content.date),
      htmlBody: content.htmlBody,
      textBody: content.textBody,
      snippet: "",
      // No threads outside Gmail; the message stands in for its own thread.
      threadId: messageId,
      integrationId,
      integrationEmail: content.integrationEmail,
    };
  } catch (err) {
    const { status, body } = providerErrorResponse(err);
    return { response: NextResponse.json(body, { status }) };
  }
}

/** A Gmail mailbox, read through Gmail's REST API as before. */
async function readGmailMessage(
  integrationId: string | undefined,
  messageId: string,
  userId: string
): Promise<MessageContent | { response: NextResponse }> {
  let ctx;
  try {
    ctx = await resolveGmailIntegration({ integrationId, messageId }, userId);
  } catch (err) {
    if (err instanceof GmailResolutionError) {
      return {
        response: NextResponse.json({ error: err.message, code: err.code }, { status: err.status }),
      };
    }
    throw err;
  }

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
      return {
        response: NextResponse.json(
          { error: "Authentication expired", code: "AUTH_EXPIRED" },
          { status: 403 }
        ),
      };
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

  const { htmlBody, textBody } = extractBodyContent(message.payload);

  return {
    subject: getHeader("Subject"),
    from: getHeader("From"),
    emailDate: new Date(getHeader("Date")),
    htmlBody,
    textBody,
    snippet: message.snippet || "",
    threadId: message.threadId,
    integrationId: ctx.integrationId,
    integrationEmail: ctx.integration.email || null,
  };
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
