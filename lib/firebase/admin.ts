/**
 * Firebase Admin SDK for server-side operations
 *
 * Uses Admin SDK to bypass security rules for server-side API routes.
 * In development, connects to the Firestore emulator.
 */

import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getStorage, Storage } from "firebase-admin/storage";

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb";
const STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "taxstudio-f12fb.firebasestorage.app";

let _adminApp: App | null = null;
let _adminDb: Firestore | null = null;
let _adminStorage: Storage | null = null;

/**
 * Check if we should use emulators
 */
function shouldUseEmulators(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.NEXT_PUBLIC_USE_EMULATORS !== "false"
  );
}

// IMPORTANT: Set emulator env vars at module load time, BEFORE any Firebase operations
// The Auth SDK reads these env vars on first use and caches the connection
if (shouldUseEmulators()) {
  process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = "localhost:9199";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
}

/**
 * Get the Firebase Admin app (singleton)
 */
export function getAdminApp(): App {
  // Env vars are set at module load time (above), but reinforce here for safety
  if (shouldUseEmulators()) {
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = "localhost:9199";
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  }

  if (_adminApp) return _adminApp;

  const existingApps = getApps();
  if (existingApps.length > 0) {
    _adminApp = existingApps[0];
    return _adminApp;
  }

  // In development/emulator mode, we can initialize without credentials
  // In production, use service account from environment
  if (shouldUseEmulators()) {
    _adminApp = initializeApp({
      projectId: PROJECT_ID,
      storageBucket: STORAGE_BUCKET,
    });
  } else {
    // Production: use service account
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (serviceAccount && serviceAccount.length > 10) {
      try {
        // Clean the service account key:
        // 1. Trim whitespace
        // 2. Remove any non-printable characters at the end
        // 3. Handle potential encoding issues
        let cleanedServiceAccount = serviceAccount.trim();
        // Remove any trailing non-JSON characters (handles BOM, null bytes, etc.)
        const lastBrace = cleanedServiceAccount.lastIndexOf("}");
        if (lastBrace > 0 && lastBrace < cleanedServiceAccount.length - 1) {
          cleanedServiceAccount = cleanedServiceAccount.substring(0, lastBrace + 1);
        }
        const parsedCredential = JSON.parse(cleanedServiceAccount);
        _adminApp = initializeApp({
          credential: cert(parsedCredential),
          projectId: PROJECT_ID,
          storageBucket: STORAGE_BUCKET,
        });
      } catch (parseError) {
        console.error("[Firebase Admin] Failed to parse service account key:", parseError);
        console.error("[Firebase Admin] Service account length:", serviceAccount?.length);
        console.error("[Firebase Admin] First 50 chars:", serviceAccount?.substring(0, 50));
        console.error("[Firebase Admin] Last 50 chars:", serviceAccount?.substring(serviceAccount.length - 50));
        // Fall back to application default credentials
        _adminApp = initializeApp({
          projectId: PROJECT_ID,
          storageBucket: STORAGE_BUCKET,
        });
      }
    } else {
      // Fallback for environments where application default credentials are available
      _adminApp = initializeApp({
        projectId: PROJECT_ID,
        storageBucket: STORAGE_BUCKET,
      });
    }
  }

  return _adminApp;
}

/**
 * Get the Admin Firestore instance (singleton)
 * This bypasses security rules and should only be used in server-side code.
 */
export function getAdminDb(): Firestore {
  if (_adminDb) return _adminDb;

  const app = getAdminApp();
  _adminDb = getFirestore(app);

  return _adminDb;
}

/**
 * Get the Admin Storage instance (singleton)
 * This bypasses security rules and should only be used in server-side code.
 */
export function getAdminStorage(): Storage {
  if (_adminStorage) return _adminStorage;

  const app = getAdminApp();
  _adminStorage = getStorage(app);

  return _adminStorage;
}

/**
 * Get the Admin Storage bucket.
 * Uses the default bucket from app config (same approach as Cloud Functions).
 */
export function getAdminBucket() {
  return getAdminStorage().bucket();
}

/**
 * Generate a Firebase Storage download URL.
 * Works with both emulator and production.
 * Matches the approach used in Cloud Functions (gmailSyncQueue.ts).
 *
 * @param bucketName - The bucket name (from bucket.name)
 * @param storagePath - The path to the file in storage
 * @param downloadToken - The download token for authentication
 */
export function getFirebaseStorageDownloadUrl(
  bucketName: string,
  storagePath: string,
  downloadToken: string
): string {
  const encodedPath = encodeURIComponent(storagePath);
  const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;

  if (storageEmulatorHost) {
    // Emulator URL format
    return `http://${storageEmulatorHost}/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${downloadToken}`;
  }

  // Production URL format
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${downloadToken}`;
}
