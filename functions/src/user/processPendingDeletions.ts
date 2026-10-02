/**
 * Scheduled function that processes pending account deletions.
 *
 * Runs daily at 3 AM UTC to process accounts whose grace period has expired.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import * as crypto from "crypto";

const REGION = "europe-west1";
const BATCH_SIZE = 500;
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * Delete all documents in a collection for a user
 */
async function deleteCollection(
  db: FirebaseFirestore.Firestore,
  collectionName: string,
  userId: string
): Promise<number> {
  let deleted = 0;

  while (true) {
    const snapshot = await db
      .collection(collectionName)
      .where("userId", "==", userId)
      .limit(BATCH_SIZE)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();

    deleted += snapshot.size;
  }

  return deleted;
}

/**
 * Delete all documents in a subcollection
 */
async function deleteSubcollection(
  db: FirebaseFirestore.Firestore,
  path: string
): Promise<number> {
  let deleted = 0;

  while (true) {
    const snapshot = await db.collection(path).limit(BATCH_SIZE).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();

    deleted += snapshot.size;
  }

  return deleted;
}

/**
 * Anonymize records instead of deleting
 */
async function anonymizeCollection(
  db: FirebaseFirestore.Firestore,
  collectionName: string,
  userId: string,
  anonymizedId: string
): Promise<number> {
  let anonymized = 0;

  while (true) {
    const snapshot = await db
      .collection(collectionName)
      .where("userId", "==", userId)
      .limit(BATCH_SIZE)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.update(doc.ref, {
        userId: anonymizedId,
        anonymizedAt: Timestamp.now(),
      });
    }
    await batch.commit();

    anonymized += snapshot.size;
  }

  return anonymized;
}

/**
 * Delete all files in a storage folder
 */
async function deleteStorageFolder(
  storage: ReturnType<typeof getStorage>,
  folderPath: string
): Promise<number> {
  const bucket = storage.bucket();
  let deleted = 0;

  try {
    const [files] = await bucket.getFiles({ prefix: folderPath });

    for (const file of files) {
      try {
        await file.delete();
        deleted++;
      } catch (err) {
        console.error(`[ProcessDeletions] Failed to delete file ${file.name}:`, err);
      }
    }
  } catch (err) {
    console.error(`[ProcessDeletions] Failed to list files in ${folderPath}:`, err);
  }

  return deleted;
}

/**
 * Revoke Gmail OAuth tokens
 */
async function revokeGmailTokens(
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<number> {
  let revoked = 0;

  const integrations = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .get();

  for (const integrationDoc of integrations.docs) {
    const integrationId = integrationDoc.id;

    const tokenDoc = await db.collection("emailTokens").doc(integrationId).get();
    if (!tokenDoc.exists) continue;

    const tokenData = tokenDoc.data();
    const accessToken = tokenData?.accessToken;

    if (accessToken) {
      try {
        const response = await fetch(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: accessToken }),
        });

        if (response.ok) {
          console.log(`[ProcessDeletions] Revoked OAuth token for integration ${integrationId}`);
          revoked++;
        } else {
          const errorText = await response.text();
          console.error(`[ProcessDeletions] Failed to revoke token: ${errorText}`);
        }
      } catch (err) {
        console.error(`[ProcessDeletions] Error revoking token:`, err);
      }
    }

    await tokenDoc.ref.delete();
  }

  return revoked;
}

/**
 * Delete a single user's account
 */
async function deleteUserAccount(
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<{
  deletedCollections: string[];
  deletedStorageFiles: number;
  anonymizedRecords: number;
}> {
  const storage = getStorage();
  const auth = getAuth();

  const anonymizedId = `deleted_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
  const deletedCollections: string[] = [];
  let deletedStorageFiles = 0;
  let anonymizedRecords = 0;

  // 1. Revoke OAuth tokens
  await revokeGmailTokens(db, userId);

  // 2. Delete user data collections
  const collectionsToDelete = [
    "fileConnections",
    "files",
    "transactions",
    "partners",
    "categories",
    "noReceiptCategories",
    "sources",
    "emailIntegrations",
    "folderIntegrations",
    "folderTokens",
    "folderEntries",
    "gmailSyncQueue",
    "gmailSyncHistory",
    "userImports",
    "userExports",
    "chatSessions",
  ];

  for (const collection of collectionsToDelete) {
    const count = await deleteCollection(db, collection, userId);
    if (count > 0) {
      deletedCollections.push(collection);
    }
  }

  // 3. Delete user subcollections
  await deleteSubcollection(db, `users/${userId}/notifications`);
  await db.collection("users").doc(userId).delete();
  deletedCollections.push("users");

  // 4. Anonymize analytics records
  const aiUsageAnonymized = await anonymizeCollection(db, "aiUsage", userId, anonymizedId);
  const functionCallsAnonymized = await anonymizeCollection(db, "functionCalls", userId, anonymizedId);
  anonymizedRecords = aiUsageAnonymized + functionCallsAnonymized;

  // 5. Delete storage files
  const foldersToDelete = [
    `files/${userId}/`,
    `exports/${userId}/`,
    `imports/${userId}/`,
    `thumbnails/${userId}/`,
  ];

  for (const folder of foldersToDelete) {
    const count = await deleteStorageFolder(storage, folder);
    deletedStorageFiles += count;
  }

  // 6. Log deletion
  await db.collection("accountDeletions").add({
    anonymizedUserId: anonymizedId,
    deletedAt: Timestamp.now(),
    deletedCollections,
    deletedStorageFiles,
    anonymizedRecords,
  });

  // 7. Delete Firebase Auth user
  try {
    await auth.deleteUser(userId);
  } catch (err) {
    console.error(`[ProcessDeletions] Failed to delete Auth user ${userId}:`, err);
  }

  return { deletedCollections, deletedStorageFiles, anonymizedRecords };
}

/**
 * Scheduled function - runs daily at 3 AM UTC
 */
export const processPendingDeletions = onSchedule(
  {
    schedule: "0 3 * * *", // 3 AM UTC daily
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();

    console.log("[ProcessDeletions] Starting scheduled deletion processing...");

    // Find all pending deletions whose grace period has expired
    const pendingDeletions = await db
      .collection("accountDeletionRequests")
      .where("status", "==", "pending")
      .where("scheduledDeletionDate", "<=", now)
      .get();

    if (pendingDeletions.empty) {
      console.log("[ProcessDeletions] No pending deletions to process.");
      return;
    }

    console.log(`[ProcessDeletions] Processing ${pendingDeletions.size} account deletions...`);

    let processed = 0;
    let failed = 0;

    for (const requestDoc of pendingDeletions.docs) {
      const requestData = requestDoc.data();
      const userId = requestData.userId;

      console.log(`[ProcessDeletions] Processing deletion for user ${userId}...`);

      try {
        const result = await deleteUserAccount(db, userId);

        // Mark request as completed
        await requestDoc.ref.update({
          status: "completed",
          completedAt: Timestamp.now(),
          deletedCollections: result.deletedCollections,
          deletedStorageFiles: result.deletedStorageFiles,
          anonymizedRecords: result.anonymizedRecords,
        });

        console.log(`[ProcessDeletions] Successfully deleted account for user ${userId}`);
        processed++;
      } catch (err) {
        console.error(`[ProcessDeletions] Failed to delete account for user ${userId}:`, err);

        // Mark request as failed
        await requestDoc.ref.update({
          status: "failed",
          failedAt: Timestamp.now(),
          error: err instanceof Error ? err.message : String(err),
        });

        failed++;
      }
    }

    console.log(
      `[ProcessDeletions] Completed. Processed: ${processed}, Failed: ${failed}`
    );
  }
);
