export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

const db = getAdminDb();
const INTEGRATIONS_COLLECTION = "emailIntegrations";
const TOKENS_COLLECTION = "emailTokens";
const SYNC_QUEUE_COLLECTION = "gmailSyncQueue";
const FILES_COLLECTION = "files";
const PARTNERS_COLLECTION = "partners";

/**
 * DELETE /api/gmail/disconnect
 * Soft-disconnect a Gmail integration.
 *
 * This performs a "soft disconnect" that:
 * 1. Revokes OAuth tokens
 * 2. Soft-deletes files WITHOUT transaction connections (keeps files with connections)
 * 3. Preserves sync state (processedMessageIds) for easy reconnection
 *
 * Query: integrationId
 */
export async function DELETE(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    const integrationId = request.nextUrl.searchParams.get("integrationId");

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

    // 1. Get tokens to revoke
    const tokenRef = db.collection(TOKENS_COLLECTION).doc(integrationId);
    const tokenSnap = await tokenRef.get();
    const tokens = tokenSnap.exists ? tokenSnap.data() : null;

    if (tokens?.accessToken) {
      try {
        // Revoke Google OAuth access
        const revokeResponse = await fetch(
          `https://oauth2.googleapis.com/revoke?token=${tokens.accessToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }
        );
        if (!revokeResponse.ok) {
          console.warn("Token revocation returned non-OK status:", revokeResponse.status);
        }
      } catch (error) {
        // Log but don't fail - token might already be invalid
        console.warn("Failed to revoke Google access:", error);
      }
    }

    // 2. Delete tokens from secure storage
    try {
      await tokenRef.delete();
    } catch (error) {
      console.warn("Failed to delete tokens:", error);
    }

    // 3. Get processedMessageIds from queue items BEFORE deleting them
    const { processedMessageIds, dateRange } = await getQueueStateAndDelete(integrationId);

    // 4. Soft delete files WITHOUT transaction connections
    const fileResult = await softDeleteFilesForIntegration(userId, integrationId);
    console.log(
      `[Disconnect] Soft-deleted ${fileResult.softDeleted} files, ` +
        `preserved ${fileResult.skipped} files with transaction connections`
    );

    // 5. Remove integration ID from partner patterns
    await removeIntegrationFromPatterns(userId, integrationId);

    // 6. Soft-disconnect the integration (preserves processedMessageIds for reconnection)
    const now = Timestamp.now();
    const updates: Record<string, unknown> = {
      isActive: false,
      disconnectedAt: now,
      processedMessageIds,
      updatedAt: now,
    };

    if (dateRange) {
      updates.lastSyncDateRange = {
        from: Timestamp.fromDate(dateRange.from),
        to: Timestamp.fromDate(dateRange.to),
      };
    }

    await integrationRef.update(updates);

    return NextResponse.json({
      success: true,
      message: "Gmail integration disconnected successfully",
      filesSoftDeleted: fileResult.softDeleted,
      filesPreserved: fileResult.skipped,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("Error disconnecting Gmail:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to disconnect Gmail" },
      { status: 500 }
    );
  }
}

/**
 * Get state from queue items before deleting them.
 * Extracts processedMessageIds and date range for preservation on the integration.
 */
async function getQueueStateAndDelete(integrationId: string): Promise<{
  processedMessageIds: string[];
  dateRange?: { from: Date; to: Date };
}> {
  try {
    const queueSnapshot = await db
      .collection(SYNC_QUEUE_COLLECTION)
      .where("integrationId", "==", integrationId)
      .get();

    // Collect all processed message IDs from all queue items
    const allProcessedIds = new Set<string>();
    let minDate: Date | undefined;
    let maxDate: Date | undefined;

    for (const queueDoc of queueSnapshot.docs) {
      const data = queueDoc.data();

      // Collect processed message IDs
      const ids = data.processedMessageIds as string[] | undefined;
      if (ids) {
        ids.forEach((id) => allProcessedIds.add(id));
      }

      // Track date range
      const from = data.dateFrom?.toDate();
      const to = data.dateTo?.toDate();
      if (from && (!minDate || from < minDate)) minDate = from;
      if (to && (!maxDate || to > maxDate)) maxDate = to;
    }

    // Delete all queue items
    const deletePromises = queueSnapshot.docs.map((d) => d.ref.delete());
    await Promise.all(deletePromises);

    console.log(
      `[Disconnect] Deleted ${queueSnapshot.size} queue items, ` +
        `preserved ${allProcessedIds.size} message IDs for future reconnection`
    );

    return {
      processedMessageIds: Array.from(allProcessedIds),
      dateRange: minDate && maxDate ? { from: minDate, to: maxDate } : undefined,
    };
  } catch (error) {
    console.warn("Failed to get queue state:", error);
    return { processedMessageIds: [] };
  }
}

/**
 * Soft delete files for an integration
 * Only deletes files that don't have transaction connections
 */
async function softDeleteFilesForIntegration(
  userId: string,
  integrationId: string
): Promise<{ softDeleted: number; skipped: number }> {
  const filesQuery = await db
    .collection(FILES_COLLECTION)
    .where("userId", "==", userId)
    .where("integrationId", "==", integrationId)
    .where("isDeleted", "!=", true)
    .get();

  let softDeleted = 0;
  let skipped = 0;
  const now = Timestamp.now();

  for (const fileDoc of filesQuery.docs) {
    const data = fileDoc.data();

    // Skip files that have transaction connections
    if (data.transactionId) {
      skipped++;
      continue;
    }

    await fileDoc.ref.update({
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
    });
    softDeleted++;
  }

  return { softDeleted, skipped };
}

/**
 * Remove integration ID from partner email patterns
 */
async function removeIntegrationFromPatterns(
  userId: string,
  integrationId: string
): Promise<void> {
  const partnersQuery = await db
    .collection(PARTNERS_COLLECTION)
    .where("userId", "==", userId)
    .get();

  const now = Timestamp.now();

  for (const partnerDoc of partnersQuery.docs) {
    const data = partnerDoc.data();
    const patterns = data.emailSearchPatterns || [];

    if (patterns.length === 0) continue;

    // Filter out the integration ID and remove patterns with no integrations left
    const updatedPatterns = patterns
      .map((p: { integrationIds: string[] }) => ({
        ...p,
        integrationIds: p.integrationIds.filter((id: string) => id !== integrationId),
      }))
      .filter((p: { integrationIds: string[] }) => p.integrationIds.length > 0);

    if (updatedPatterns.length !== patterns.length) {
      await partnerDoc.ref.update({
        emailSearchPatterns: updatedPatterns,
        emailPatternsUpdatedAt: now,
        updatedAt: now,
      });
    }
  }
}
