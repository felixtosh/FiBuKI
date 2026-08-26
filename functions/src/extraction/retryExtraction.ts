import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import {
  RetryExtractionError,
  retryExtractionForFile,
  type RetryRefusalCode,
} from "./retryExtractionOps";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const db = getFirestore();

const ERROR_CODES: Record<RetryRefusalCode, "not-found" | "permission-denied" | "failed-precondition" | "internal"> = {
  NOT_FOUND: "not-found",
  ACCESS_DENIED: "permission-denied",
  ALREADY_EXTRACTED: "failed-precondition",
  HAND_CORRECTED: "failed-precondition",
  EXTRACTION_FAILED: "internal",
};

/**
 * Callable function to retry extraction for a file.
 * Used for:
 * - Files with extraction errors
 * - Files user marked as invoice (overriding AI classification)
 * - Files that extracted "successfully" but produced nothing usable (force)
 *
 * A file carrying hand corrections (#184) is refused unless the caller also
 * passes overwriteCorrections — the UI's retry button always passes force, so
 * force cannot be what protects a correction.
 *
 * The eligibility rule and the writes live in retryExtractionOps, shared with
 * the retry_file_extraction tool on the MCP surface.
 */
export const retryFileExtraction = onCall(
  {
    region: "europe-west1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [anthropicApiKey],
    cors: CORS_ORIGINS,
  },
  async (request) => {
    const { fileId, force, overwriteCorrections } = request.data;

    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    if (!fileId || typeof fileId !== "string") {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    try {
      return await retryExtractionForFile(db, {
        fileId,
        userId: request.auth.uid,
        force: force === true,
        overwriteCorrections: overwriteCorrections === true,
        anthropicApiKey: anthropicApiKey.value(),
      });
    } catch (error) {
      if (error instanceof RetryExtractionError) {
        throw new HttpsError(ERROR_CODES[error.code], error.message);
      }
      throw error;
    }
  }
);
