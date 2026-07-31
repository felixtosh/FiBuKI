export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { GmailClient } from "@/lib/email-providers/gmail-client";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";

/**
 * POST /api/gmail/email-content
 * Get the HTML and text body content of an email
 *
 * Body: {
 *   integrationId: string;
 *   messageId: string;
 * }
 *
 * Response: {
 *   htmlBody?: string;
 *   textBody?: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { integrationId, messageId } = body;

    if (!integrationId) {
      return NextResponse.json(
        { error: "integrationId is required" },
        { status: 400 }
      );
    }

    if (!messageId) {
      return NextResponse.json(
        { error: "messageId is required" },
        { status: 400 }
      );
    }

    // Verify integration exists and belongs to user
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
        {
          error: "Re-authentication required",
          code: "REAUTH_REQUIRED",
        },
        { status: 403 }
      );
    }

    // Get tokens from secure storage
    const tokenSnap = await db.collection(TOKENS_COLLECTION).doc(integrationId).get();
    if (!tokenSnap.exists) {
      return NextResponse.json(
        {
          error: "Tokens not found. Please reconnect Gmail.",
          code: "TOKENS_MISSING",
        },
        { status: 403 }
      );
    }

    const tokens = tokenSnap.data()!;

    // Check if token is expired
    const expiresAt = tokens.expiresAt.toDate();
    const now = new Date();
    if (expiresAt < now) {
      await integrationRef.update({
        needsReauth: true,
        lastError: "Access token expired",
        updatedAt: Timestamp.now(),
      });
      return NextResponse.json(
        {
          error: "Access token expired. Please reconnect Gmail.",
          code: "TOKEN_EXPIRED",
        },
        { status: 403 }
      );
    }

    // Create Gmail client
    const gmailClient = new GmailClient(
      integrationId,
      tokens.accessToken,
      tokens.refreshToken || ""
    );

    // Get email content
    const content = await gmailClient.getEmailContent(messageId);

    // Update last accessed time (fire and forget - don't block response)
    integrationRef.update({
      lastAccessedAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }).catch((err) => console.error("[email-content] Failed to update lastAccessedAt:", err));

    return NextResponse.json({
      success: true,
      htmlBody: content.htmlBody,
      textBody: content.textBody,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Error fetching email content:", error);

    if (error instanceof Error) {
      if (error.message === "AUTH_EXPIRED") {
        return NextResponse.json(
          {
            error: "Authentication expired. Please reconnect Gmail.",
            code: "AUTH_EXPIRED",
          },
          { status: 403 }
        );
      }
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch email content" },
      { status: 500 }
    );
  }
}
