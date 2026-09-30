export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { activateMailIntegration } from "@/functions/src/mail/activateMailIntegration";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";

/**
 * POST /api/gmail/resume
 * Resume a paused mailbox: mark it ready and queue the per-Transaction
 * receipt search (#103). No Sync is started.
 *
 * Body: {
 *   integrationId: string;
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const body = await request.json();
    const { integrationId } = body;

    if (!integrationId) {
      return NextResponse.json(
        { error: "integrationId is required" },
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

    // Check if reauth is needed
    if (integration.needsReauth) {
      await integrationRef.update({ isPaused: false, pausedAt: null, updatedAt: Timestamp.now() });
      return NextResponse.json({
        success: true,
        message: "Resumed, but re-authentication is required",
        needsReauth: true,
        searchQueued: false,
      });
    }

    // #103: resuming does not restart a Sync. It marks the mailbox ready and
    // searches it per undocumented Transaction.
    await integrationRef.update({ pausedAt: null });
    const { searchQueued, transactionsToProcess } = await activateMailIntegration({
      integrationId,
      userId,
      email: integration.email,
      reason: "mail_service_resumed",
      notify: false,
    });
    console.log(`[Gmail Resume] Resumed integration: ${integration.email}`);

    return NextResponse.json({
      success: true,
      message: searchQueued
        ? `Resumed. Searching for the receipts of ${transactionsToProcess} open transactions.`
        : "Resumed.",
      searchQueued,
      transactionsToProcess,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Gmail Resume] Error:", error);
    return NextResponse.json(
      { error: "Failed to resume sync" },
      { status: 500 }
    );
  }
}
