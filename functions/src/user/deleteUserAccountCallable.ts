/**
 * Complete account deletion callable.
 *
 * Deletes all user data across all collections, revokes OAuth tokens,
 * and deletes the Firebase Auth user.
 *
 * This is an irreversible operation.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import * as crypto from "crypto";

const BATCH_SIZE = 500;

// Google OAuth revoke endpoint
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface DeleteUserAccountRequest {
  confirmationPhrase: string;
}

interface DeleteUserAccountResponse {
  success: boolean;
  deletedCollections: string[];
  deletedStorageFiles: number;
  anonymizedRecords: number;
}

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
 * Delete a single document by ID
 */
async function deleteDocById(
  db: FirebaseFirestore.Firestore,
  collection: string,
  docId: string
): Promise<boolean> {
  const doc = await db.collection(collection).doc(docId).get();
  if (doc.exists) {
    await doc.ref.delete();
    return true;
  }
  return false;
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
 * Anonymize records instead of deleting (for analytics/compliance)
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
        anonymizedAt: FieldValue.serverTimestamp(),
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
        console.error(`[DeleteAccount] Failed to delete file ${file.name}:`, err);
      }
    }
  } catch (err) {
    console.error(`[DeleteAccount] Failed to list files in ${folderPath}:`, err);
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

  // Get all email integrations for this user
  const integrations = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .get();

  for (const integrationDoc of integrations.docs) {
    const integrationId = integrationDoc.id;

    // Get the token document
    const tokenDoc = await db.collection("emailTokens").doc(integrationId).get();
    if (!tokenDoc.exists) continue;

    const tokenData = tokenDoc.data();
    const accessToken = tokenData?.accessToken;

    if (accessToken) {
      try {
        // Revoke the access token (this also invalidates the refresh token)
        const response = await fetch(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: accessToken }),
        });

        if (response.ok) {
          console.log(`[DeleteAccount] Revoked OAuth token for integration ${integrationId}`);
          revoked++;
        } else {
          const errorText = await response.text();
          console.error(`[DeleteAccount] Failed to revoke token: ${errorText}`);
        }
      } catch (err) {
        console.error(`[DeleteAccount] Error revoking token:`, err);
      }
    }

    // Delete the token document
    await tokenDoc.ref.delete();
  }

  return revoked;
}

export interface DeleteUserDataResult {
  deletedCollections: string[];
  deletedStorageFiles: number;
  anonymizedRecords: number;
}

/**
 * Shared helper that performs the actual account deletion.
 * Used by both self-service (deleteUserAccountCallable) and admin (adminDeleteUserCallable).
 */
export async function deleteUserData(
  db: FirebaseFirestore.Firestore,
  userId: string,
  deletedBy?: string
): Promise<DeleteUserDataResult> {
  const storage = getStorage();
  const auth = getAuth();

  console.log(`[DeleteAccount] Starting account deletion for user ${userId}${deletedBy ? ` (by ${deletedBy})` : ""}`);

  // Generate anonymized ID for analytics records
  const anonymizedId = `deleted_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;

  const deletedCollections: string[] = [];
  let deletedStorageFiles = 0;
  let anonymizedRecords = 0;

  // === 1. Revoke OAuth tokens and delete token documents ===
  console.log("[DeleteAccount] Revoking OAuth tokens...");
  await revokeGmailTokens(db, userId);

  // === 2. Delete user data collections ===
  const collectionsToDelete = [
    "fileConnections",
    "files",
    "transactions",
    "partners",
    "categories",
    "noReceiptCategories",
    "sources",
    "emailIntegrations",
    "gmailSyncQueue",
    "gmailSyncHistory",
    "userImports",
    "userExports",
    "chatSessions",
  ];

  for (const collection of collectionsToDelete) {
    console.log(`[DeleteAccount] Deleting ${collection}...`);
    const count = await deleteCollection(db, collection, userId);
    if (count > 0) {
      console.log(`[DeleteAccount] Deleted ${count} ${collection}`);
      deletedCollections.push(collection);
    }
  }

  // === 3. Delete user subcollections ===
  console.log("[DeleteAccount] Deleting user settings and notifications...");
  await deleteSubcollection(db, `users/${userId}/notifications`);
  await deleteDocById(db, `users/${userId}/settings`, "userData");
  await db.collection("users").doc(userId).delete();
  deletedCollections.push("users");

  // === 4. Anonymize analytics records (keep for billing/usage tracking) ===
  console.log("[DeleteAccount] Anonymizing analytics records...");
  const aiUsageAnonymized = await anonymizeCollection(db, "aiUsage", userId, anonymizedId);
  const functionCallsAnonymized = await anonymizeCollection(db, "functionCalls", userId, anonymizedId);
  anonymizedRecords = aiUsageAnonymized + functionCallsAnonymized;
  console.log(`[DeleteAccount] Anonymized ${anonymizedRecords} analytics records`);

  // === 5. Delete storage files ===
  console.log("[DeleteAccount] Deleting storage files...");
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
  console.log(`[DeleteAccount] Deleted ${deletedStorageFiles} storage files`);

  // === 6. Log deletion for compliance ===
  await db.collection("accountDeletions").add({
    anonymizedUserId: anonymizedId,
    deletedAt: Timestamp.now(),
    deletedCollections,
    deletedStorageFiles,
    anonymizedRecords,
    ...(deletedBy ? { deletedBy } : {}),
  });

  // === 7. Delete Firebase Auth user (MUST BE LAST) ===
  console.log("[DeleteAccount] Deleting Firebase Auth user...");
  try {
    await auth.deleteUser(userId);
    console.log(`[DeleteAccount] Deleted Firebase Auth user ${userId}`);
  } catch (err) {
    // Log but don't fail - user might have been deleted already
    console.error(`[DeleteAccount] Failed to delete Auth user:`, err);
  }

  console.log(`[DeleteAccount] Account deletion complete for ${anonymizedId}`);

  return {
    deletedCollections,
    deletedStorageFiles,
    anonymizedRecords,
  };
}

export const deleteUserAccountCallable = createCallable<
  DeleteUserAccountRequest,
  DeleteUserAccountResponse
>(
  {
    name: "deleteUserAccount",
    memory: "1GiB",
    timeoutSeconds: 540, // 9 minutes for large accounts
  },
  async (ctx, request) => {
    const { confirmationPhrase } = request;

    // Require exact confirmation phrase
    if (confirmationPhrase !== "DELETE MY ACCOUNT") {
      throw new HttpsError(
        "invalid-argument",
        "Invalid confirmation phrase. Please type 'DELETE MY ACCOUNT' exactly."
      );
    }

    const result = await deleteUserData(ctx.db, ctx.userId);

    return {
      success: true,
      ...result,
    };
  }
);
