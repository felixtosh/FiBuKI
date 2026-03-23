import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

const db = getFirestore();
const MIGRATION_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";
const OLD_USER_ID = "dev-user-123";

/**
 * Collections that need to be migrated from dev-user-123 to real user
 */
const COLLECTIONS_TO_MIGRATE = [
  "sources",
  "transactions",
  "files",
  "partners",
  "emailIntegrations",
  "emailTokens",
  "noReceiptCategories",
  "chatSessions",
  "aiUsage",
  "fileConnections",
  "gmailSyncQueue",
  "precisionSearchQueue",
  "imports",
  "notifications",
];

/**
 * Callable function to migrate dev-user-123 data to the real user
 * Only callable by the designated migration user (SUPER_ADMIN_EMAIL)
 *
 * This is a one-time migration function that should be called after first login
 */
export const migrateUserData = onCall(
  {
    region: "europe-west1",
    timeoutSeconds: 540, // 9 minutes for large migrations
    cors: CORS_ORIGINS,
  },
  async (request) => {
    // Verify caller is authenticated
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const callerEmail = request.auth.token.email;
    const newUserId = request.auth.uid;

    // Only allow the designated migration user
    if (callerEmail !== MIGRATION_EMAIL) {
      throw new HttpsError(
        "permission-denied",
        "Only the designated admin can migrate data"
      );
    }

    console.log(`Starting migration from ${OLD_USER_ID} to ${newUserId}`);

    const results: Record<string, { migrated: number; errors: number }> = {};
    let totalMigrated = 0;
    let totalErrors = 0;

    try {
      // Migrate each collection
      for (const collectionName of COLLECTIONS_TO_MIGRATE) {
        console.log(`Migrating collection: ${collectionName}`);

        const collectionRef = db.collection(collectionName);
        const snapshot = await collectionRef
          .where("userId", "==", OLD_USER_ID)
          .get();

        let migrated = 0;
        let errors = 0;

        // Process in batches of 500
        const batches: FirebaseFirestore.WriteBatch[] = [];
        let currentBatch = db.batch();
        let operationsInBatch = 0;

        for (const doc of snapshot.docs) {
          try {
            currentBatch.update(doc.ref, { userId: newUserId });
            operationsInBatch++;

            if (operationsInBatch >= 500) {
              batches.push(currentBatch);
              currentBatch = db.batch();
              operationsInBatch = 0;
            }
            migrated++;
          } catch (error) {
            console.error(`Error preparing migration for ${collectionName}/${doc.id}:`, error);
            errors++;
          }
        }

        // Don't forget the last batch
        if (operationsInBatch > 0) {
          batches.push(currentBatch);
        }

        // Commit all batches
        for (const batch of batches) {
          await batch.commit();
        }

        results[collectionName] = { migrated, errors };
        totalMigrated += migrated;
        totalErrors += errors;

        console.log(`  ${collectionName}: ${migrated} migrated, ${errors} errors`);
      }

      // Migrate user settings subcollection
      console.log("Migrating user settings...");
      try {
        const oldUserDataRef = db.doc(`users/${OLD_USER_ID}/settings/userData`);
        const oldUserData = await oldUserDataRef.get();

        if (oldUserData.exists) {
          const newUserDataRef = db.doc(`users/${newUserId}/settings/userData`);
          await newUserDataRef.set(oldUserData.data()!);
          console.log("  User settings migrated successfully");
        } else {
          console.log("  No user settings to migrate");
        }
      } catch (error) {
        console.error("Error migrating user settings:", error);
        totalErrors++;
      }

      // Record the migration in a log collection
      await db.collection("migrations").add({
        type: "user_data_migration",
        fromUserId: OLD_USER_ID,
        toUserId: newUserId,
        toEmail: callerEmail,
        completedAt: FieldValue.serverTimestamp(),
        results,
        totalMigrated,
        totalErrors,
      });

      console.log(`Migration complete: ${totalMigrated} documents migrated, ${totalErrors} errors`);

      return {
        success: true,
        totalMigrated,
        totalErrors,
        results,
      };
    } catch (error) {
      console.error("Migration failed:", error);
      throw new HttpsError("internal", "Migration failed. Check logs for details.");
    }
  }
);

/**
 * Check migration status - whether migration is needed or already done
 */
export const checkMigrationStatus = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const callerEmail = request.auth.token.email;
    const userId = request.auth.uid;

    // Only relevant for the migration user
    if (callerEmail !== MIGRATION_EMAIL) {
      return { needsMigration: false, reason: "Not migration user" };
    }

    try {
      // Check if migration was already done
      const migrationsQuery = await db
        .collection("migrations")
        .where("type", "==", "user_data_migration")
        .where("toUserId", "==", userId)
        .limit(1)
        .get();

      if (!migrationsQuery.empty) {
        const migrationData = migrationsQuery.docs[0].data();
        return {
          needsMigration: false,
          reason: "Already migrated",
          migrationDate: migrationData.completedAt?.toDate?.()?.toISOString(),
          totalMigrated: migrationData.totalMigrated,
        };
      }

      // Check if there's data to migrate
      const sampleCollection = await db
        .collection("transactions")
        .where("userId", "==", OLD_USER_ID)
        .limit(1)
        .get();

      if (sampleCollection.empty) {
        return { needsMigration: false, reason: "No data to migrate" };
      }

      return {
        needsMigration: true,
        reason: `Data found for ${OLD_USER_ID}`,
      };
    } catch (error) {
      console.error("Error checking migration status:", error);
      throw new HttpsError("internal", "Failed to check migration status");
    }
  }
);
