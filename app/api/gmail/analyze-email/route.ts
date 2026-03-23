export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { VertexAI } from "@google-cloud/vertexai";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

const GEMINI_MODEL = "gemini-2.0-flash-lite-001";
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "europe-west1";

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
 * POST /api/gmail/analyze-email
 * Analyze an email for invoice links or determine if it's an HTML invoice
 *
 * Body: {
 *   integrationId: string;
 *   messageId: string;
 *   transaction: {
 *     name: string;
 *     partner?: string;
 *     amount: number;
 *   };
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { integrationId, messageId, transaction } = body;

    if (!integrationId || !messageId) {
      return NextResponse.json(
        { error: "integrationId and messageId are required" },
        { status: 400 }
      );
    }

    // Verify integration
    const integrationRef = db.collection(INTEGRATIONS_COLLECTION).doc(integrationId);
    const integrationSnap = await integrationRef.get();

    if (!integrationSnap.exists) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    const integration = integrationSnap.data()!;
    if (integration.userId !== userId) {
      return NextResponse.json(
        { error: "Integration not found" },
        { status: 404 }
      );
    }

    if (integration.needsReauth) {
      return NextResponse.json(
        { error: "Re-authentication required", code: "REAUTH_REQUIRED" },
        { status: 403 }
      );
    }

    // Get tokens
    const tokenSnap = await db.collection(TOKENS_COLLECTION).doc(integrationId).get();
    if (!tokenSnap.exists) {
      return NextResponse.json(
        { error: "Tokens not found. Please reconnect Gmail.", code: "TOKENS_MISSING" },
        { status: 403 }
      );
    }

    const tokens = tokenSnap.data()!;

    // Check if token is expired
    const expiresAt = tokens.expiresAt.toDate();
    if (expiresAt < new Date()) {
      await integrationRef.update({
        needsReauth: true,
        lastError: "Access token expired",
        updatedAt: Timestamp.now(),
      });
      return NextResponse.json(
        { error: "Access token expired. Please reconnect Gmail.", code: "TOKEN_EXPIRED" },
        { status: 403 }
      );
    }

    // Fetch the message
    const messageResponse = await fetch(
      `${GMAIL_API_BASE}/users/me/messages/${messageId}?format=full`,
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
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

    // Extract body content
    const { htmlBody, textBody } = extractBodyContent(message.payload);

    // Analyze with Gemini
    const analysis = await analyzeEmailWithGemini(
      { subject, from, htmlBody, textBody },
      transaction
    );

    return NextResponse.json({
      messageId,
      subject,
      from,
      date: dateStr,
      ...analysis,
    });
  } catch (error) {
    console.error("[analyze-email] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to analyze email" },
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
 * Analyze email content with Gemini
 */
async function analyzeEmailWithGemini(
  emailContent: {
    subject: string;
    from: string;
    htmlBody?: string;
    textBody?: string;
  },
  transaction?: {
    name: string;
    partner?: string;
    amount: number;
  }
): Promise<{
  hasInvoiceLink: boolean;
  invoiceLinks: Array<{ url: string; anchorText?: string }>;
  isMailInvoice: boolean;
  mailInvoiceConfidence: number;
  reasoning: string;
}> {
  const vertexAI = new VertexAI({ project: PROJECT_ID, location: VERTEX_LOCATION });
  const model = vertexAI.getGenerativeModel({ model: GEMINI_MODEL });

  const amount = transaction ? Math.abs(transaction.amount / 100).toFixed(2) : "unknown";

  // Use text body if available, otherwise strip HTML
  let bodyContent = emailContent.textBody || "";
  if (!bodyContent && emailContent.htmlBody) {
    bodyContent = emailContent.htmlBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  bodyContent = bodyContent.substring(0, 3000);

  // Extract links from HTML for better link detection
  let linksFromHtml: Array<{ url: string; anchorText: string }> = [];
  if (emailContent.htmlBody) {
    const linkRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(emailContent.htmlBody)) !== null) {
      linksFromHtml.push({ url: match[1], anchorText: match[2].trim() });
    }
  }

  const prompt = `Analyze this email for invoice-related content.

Email:
From: ${emailContent.from}
Subject: ${emailContent.subject}
Body (excerpt): ${bodyContent}

${linksFromHtml.length > 0 ? `
Links found in email:
${linksFromHtml.slice(0, 20).map(l => `- ${l.anchorText}: ${l.url}`).join("\n")}
` : ""}

${transaction ? `
Transaction we're matching:
- Description: ${transaction.name}
- Partner: ${transaction.partner || "Unknown"}
- Amount: €${amount}
` : ""}

Determine:
1. Does this email contain LINKS to download/view an invoice? Extract all invoice-related URLs (look for keywords like: invoice, rechnung, receipt, beleg, download, view, PDF).
2. Is the EMAIL ITSELF an invoice (e.g., receipt email, confirmation with itemized charges)?

Return JSON only:
{
  "hasInvoiceLink": true/false,
  "invoiceLinks": [{"url": "...", "anchorText": "..."}],
  "isMailInvoice": true/false,
  "mailInvoiceConfidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        hasInvoiceLink: false,
        invoiceLinks: [],
        isMailInvoice: false,
        mailInvoiceConfidence: 0,
        reasoning: "Failed to parse response",
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      hasInvoiceLink: parsed.hasInvoiceLink || false,
      invoiceLinks: parsed.invoiceLinks || [],
      isMailInvoice: parsed.isMailInvoice || false,
      mailInvoiceConfidence: parsed.mailInvoiceConfidence || 0,
      reasoning: parsed.reasoning || "",
    };
  } catch {
    console.error("[analyze-email] Failed to parse Gemini response:", text);
    return {
      hasInvoiceLink: false,
      invoiceLinks: [],
      isMailInvoice: false,
      mailInvoiceConfidence: 0,
      reasoning: "Parse error",
    };
  }
}
