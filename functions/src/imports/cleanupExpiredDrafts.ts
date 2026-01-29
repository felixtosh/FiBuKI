/**
 * Scheduled function to cleanup expired draft imports.
 * Runs daily at 3:00 AM Berlin time.
 * Deletes both the import record and associated CSV file from storage.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const BATCH_SIZE = 100;

export const cleanupExpiredDrafts = onSchedule(
  {
    schedule: "0 3 * * *", // 03:00 daily
    timeZone: "Europe/Berlin",
    region: "europe-west1",
  },
  async () => {
    const db = getFirestore();
    const bucket = getStorage().bucket();
    const now = Timestamp.now();

    console.log("[cleanupExpiredDrafts] Starting cleanup...");

    // Find expired drafts
    const expiredDraftsQuery = await db
      .collection("imports")
      .where("status", "==", "draft")
      .where("expiresAt", "<=", now)
      .limit(BATCH_SIZE)
      .get();

    if (expiredDraftsQuery.empty) {
      console.log("[cleanupExpiredDrafts] No expired drafts found");
      return;
    }

    console.log(
      `[cleanupExpiredDrafts] Found ${expiredDraftsQuery.size} expired drafts`
    );

    let deletedCount = 0;
    let errorCount = 0;

    for (const doc of expiredDraftsQuery.docs) {
      const data = doc.data();

      try {
        // Delete CSV file from storage if it exists
        if (data.csvStoragePath) {
          try {
            await bucket.file(data.csvStoragePath).delete();
            console.log(
              `[cleanupExpiredDrafts] Deleted CSV: ${data.csvStoragePath}`
            );
          } catch (storageError) {
            // Log but don't fail - file may already be deleted
            console.warn(
              `[cleanupExpiredDrafts] Could not delete CSV ${data.csvStoragePath}: ${storageError}`
            );
          }
        }

        // Delete the import record
        await doc.ref.delete();
        deletedCount++;

        console.log(`[cleanupExpiredDrafts] Deleted draft: ${doc.id}`, {
          userId: data.userId,
          sourceId: data.sourceId,
          fileName: data.fileName,
          createdAt: data.createdAt?.toDate?.()?.toISOString(),
          expiresAt: data.expiresAt?.toDate?.()?.toISOString(),
        });
      } catch (error) {
        errorCount++;
        console.error(
          `[cleanupExpiredDrafts] Error deleting draft ${doc.id}: ${error}`
        );
      }
    }

    console.log(
      `[cleanupExpiredDrafts] Completed. Deleted: ${deletedCount}, Errors: ${errorCount}`
    );

    // If we hit the batch limit, there may be more to process
    if (expiredDraftsQuery.size === BATCH_SIZE) {
      console.log(
        "[cleanupExpiredDrafts] Batch limit reached - more drafts may need cleanup"
      );
    }
  }
);
