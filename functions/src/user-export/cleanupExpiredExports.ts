/**
 * Scheduled function to clean up expired exports.
 * Runs daily and deletes exports older than EXPORT_EXPIRY_DAYS.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

/**
 * Clean up expired exports daily at 3 AM
 */
export const cleanupExpiredExports = onSchedule(
  {
    schedule: "0 3 * * *", // 3 AM daily
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 300, // 5 minutes
  },
  async () => {
    const db = getFirestore();
    const storage = getStorage();
    const bucket = storage.bucket();

    const now = Timestamp.now();

    console.log("[cleanupExpiredExports] Starting cleanup");

    // Find expired exports
    const expiredExports = await db
      .collection("userExports")
      .where("expiresAt", "<", now)
      .get();

    console.log(`[cleanupExpiredExports] Found ${expiredExports.size} expired exports`);

    let deleted = 0;
    let errors = 0;

    for (const doc of expiredExports.docs) {
      try {
        const exportData = doc.data();
        const storagePath = exportData.storagePath as string;

        // Delete from storage
        if (storagePath) {
          try {
            await bucket.file(storagePath).delete();
            console.log(`[cleanupExpiredExports] Deleted storage: ${storagePath}`);
          } catch (err) {
            // File might already be deleted
            console.log(`[cleanupExpiredExports] Storage file not found: ${storagePath}`);
          }
        }

        // Delete document
        await doc.ref.delete();
        deleted++;
      } catch (err) {
        console.error(`[cleanupExpiredExports] Failed to delete ${doc.id}:`, err);
        errors++;
      }
    }

    // Also clean up failed exports older than 7 days
    const failedThreshold = Timestamp.fromDate(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    );

    const oldFailedExports = await db
      .collection("userExports")
      .where("status", "==", "failed")
      .where("createdAt", "<", failedThreshold)
      .get();

    for (const doc of oldFailedExports.docs) {
      try {
        await doc.ref.delete();
        deleted++;
      } catch (err) {
        console.error(`[cleanupExpiredExports] Failed to delete failed export ${doc.id}:`, err);
        errors++;
      }
    }

    console.log(
      `[cleanupExpiredExports] Completed: ${deleted} deleted, ${errors} errors`
    );
  }
);
