/**
 * Cleanup Orphaned Transactions Callable
 *
 * Admin function to find and delete transactions whose sourceId
 * doesn't exist anymore. These are leftovers from failed source deletions.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { isAdminCaller } from "../utils/adminCaller";
import type {
  CleanupOrphanedTransactionsRequest,
  CleanupOrphanedTransactionsResponse,
} from "../types/banking-sync";

export const cleanupOrphanedTransactionsCallable = createCallable<
  CleanupOrphanedTransactionsRequest,
  CleanupOrphanedTransactionsResponse
>(
  {
    name: "cleanupOrphanedTransactions",
    timeoutSeconds: 300, // 5 minutes for large cleanups
    memory: "512MiB",
  },
  async (ctx, request) => {
    const { dryRun = true, targetUserId } = request;
    const db = ctx.db;

    // Check if caller is admin when targeting another user
    let cleanupUserId = ctx.userId;

    if (targetUserId && targetUserId !== ctx.userId) {
      // The admin bit comes from the verified token only. This used to read
      // users/{uid}.isAdmin, which the caller can write on the data plane, so
      // any user could delete another user's transactions.
      if (!isAdminCaller(ctx.request.auth)) {
        throw new HttpsError(
          "permission-denied",
          "Only admins can cleanup other users' transactions"
        );
      }

      cleanupUserId = targetUserId;
    }

    // ========================================================================
    // Get all valid sourceIds for this user
    // ========================================================================
    const sourcesQuery = await db
      .collection("sources")
      .where("userId", "==", cleanupUserId)
      .get();

    const validSourceIds = new Set(sourcesQuery.docs.map((d) => d.id));
    console.log(
      `[cleanupOrphanedTransactions] User ${cleanupUserId} has ${validSourceIds.size} valid sources`
    );

    // ========================================================================
    // Get all transactions for this user
    // ========================================================================
    const transactionsQuery = await db
      .collection("transactions")
      .where("userId", "==", cleanupUserId)
      .get();

    console.log(
      `[cleanupOrphanedTransactions] Found ${transactionsQuery.docs.length} total transactions`
    );

    // ========================================================================
    // Find orphaned transactions (sourceId doesn't exist)
    // ========================================================================
    const orphanedDocs = transactionsQuery.docs.filter((d) => {
      const sourceId = d.data().sourceId;
      return sourceId && !validSourceIds.has(sourceId);
    });

    // Group by sourceId for logging
    const orphanedBySource = new Map<string, number>();
    for (const doc of orphanedDocs) {
      const sourceId = doc.data().sourceId;
      orphanedBySource.set(sourceId, (orphanedBySource.get(sourceId) || 0) + 1);
    }

    console.log(
      `[cleanupOrphanedTransactions] Found ${orphanedDocs.length} orphaned transactions:`
    );
    for (const [sourceId, count] of orphanedBySource) {
      console.log(`  - ${sourceId}: ${count} transactions`);
    }

    // ========================================================================
    // Dry run - return without deleting
    // ========================================================================
    if (dryRun) {
      return {
        dryRun: true,
        orphanedCount: orphanedDocs.length,
        orphanedBySource: Object.fromEntries(orphanedBySource),
      };
    }

    // ========================================================================
    // Delete orphaned transactions
    // ========================================================================
    const BATCH_SIZE = 500;
    let deleted = 0;

    for (let i = 0; i < orphanedDocs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const slice = orphanedDocs.slice(i, i + BATCH_SIZE);

      for (const doc of slice) {
        batch.delete(doc.ref);
        deleted++;
      }

      await batch.commit();
    }

    console.log(
      `[cleanupOrphanedTransactions] Deleted ${deleted} orphaned transactions`
    );

    return {
      dryRun: false,
      orphanedCount: orphanedDocs.length,
      orphanedBySource: Object.fromEntries(orphanedBySource),
      deleted,
    };
  }
);
