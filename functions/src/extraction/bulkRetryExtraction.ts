import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { RetryExtractionError, retryExtractionForFile } from "./retryExtractionOps";

const FIREBASE_PROJECT_ID =
  process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

const db = getFirestore();

interface BulkRetryRequest {
  /** UID whose errored files should be rescanned. */
  targetUid: string;
}

interface BulkRetryResponse {
  /** Errored files queued for a fresh Extraction. */
  queued: number;
  /**
   * Errored files left alone because a person corrected their record by hand
   * (#184): a re-extraction would discard the corrections.
   */
  skippedHandCorrected: number;
}

/**
 * Queues a fresh Extraction for every file of `targetUid` whose previous
 * extraction errored out. Admin-only (or super-admin, or the user themselves).
 *
 * Each file goes through the same checks and reset as a single Retry
 * (retryExtractionOps), then waits for the extraction worker; this returns
 * as soon as everything is queued (#603), so there is no per-call cap and no
 * time budget. How each Extraction went lands on its File.
 */
export const bulkRetryExtraction = onCall<BulkRetryRequest, Promise<BulkRetryResponse>>(
  {
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "1GiB",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { targetUid } = request.data;
    if (!targetUid || typeof targetUid !== "string") {
      throw new HttpsError("invalid-argument", "targetUid is required");
    }

    const callerUid = request.auth.uid;
    const callerEmail = request.auth.token.email;
    const callerIsAdmin = request.auth.token.admin === true;
    const isSelf = callerUid === targetUid;
    const isSuperAdmin =
      !!callerEmail && callerEmail === SUPER_ADMIN_EMAIL;
    if (!callerIsAdmin && !isSuperAdmin && !isSelf) {
      throw new HttpsError(
        "permission-denied",
        "Only admins can bulk-rescan another user's files",
      );
    }

    const erroredQuery = await db
      .collection("files")
      .where("userId", "==", targetUid)
      .where("extractionError", "!=", null)
      .get();

    let queued = 0;
    let skippedHandCorrected = 0;
    for (const doc of erroredQuery.docs) {
      try {
        // The target owns the file; the caller's right to act for them was
        // checked above.
        await retryExtractionForFile(db, { fileId: doc.id, userId: targetUid });
        queued++;
      } catch (error) {
        if (error instanceof RetryExtractionError && error.code === "HAND_CORRECTED") {
          skippedHandCorrected++;
          continue;
        }
        throw error;
      }
    }

    console.log(
      `Bulk rescan: caller=${callerEmail} target=${targetUid} queued=${queued} skippedHandCorrected=${skippedHandCorrected}`,
    );

    return { queued, skippedHandCorrected };
  },
);
