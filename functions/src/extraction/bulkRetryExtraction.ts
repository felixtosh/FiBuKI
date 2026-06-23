import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { runExtraction } from "./extractionCore";

const FIREBASE_PROJECT_ID =
  process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const db = getFirestore();

const MAX_FILES_PER_CALL = 50;
const PARALLELISM = 5;

interface BulkRetryRequest {
  /** UID whose errored files should be rescanned. */
  targetUid: string;
  /** Optional cap; defaults/clamps to MAX_FILES_PER_CALL. */
  maxFiles?: number;
}

interface BulkRetryResponse {
  /** Files processed in this call. */
  processed: number;
  /** Files that succeeded extraction. */
  succeeded: number;
  /** Files that failed again (with their new error message). */
  failed: number;
  /** True if more errored files remain — call again to continue. */
  hasMore: boolean;
  /** Sample of failure messages from this batch (max 5). */
  sampleErrors: string[];
}

/**
 * Bulk re-runs extraction on all files for `targetUid` whose previous
 * extraction errored out. Admin-only (or super-admin, or the user themselves).
 *
 * Processes up to MAX_FILES_PER_CALL files with PARALLELISM concurrent
 * extractions. Returns `hasMore: true` if more remain — the caller can poll
 * until `hasMore` is false.
 *
 * Mirrors `retryFileExtraction`'s reset semantics so partner / transaction
 * matching also re-runs after extraction.
 */
export const bulkRetryExtraction = onCall<BulkRetryRequest, Promise<BulkRetryResponse>>(
  {
    region: "europe-west1",
    timeoutSeconds: 540, // 9 min — close to GCF v2 cap; PARALLELISM keeps it bounded
    memory: "1GiB",
    secrets: [anthropicApiKey],
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

    const maxFiles = Math.min(
      Math.max(1, request.data.maxFiles ?? MAX_FILES_PER_CALL),
      MAX_FILES_PER_CALL,
    );

    // Query errored files for the target user. Pull maxFiles + 1 to detect
    // hasMore in one round-trip.
    const erroredQuery = await db
      .collection("files")
      .where("userId", "==", targetUid)
      .where("extractionError", "!=", null)
      .limit(maxFiles + 1)
      .get();

    const allDocs = erroredQuery.docs;
    const toProcess = allDocs.slice(0, maxFiles);
    const hasMore = allDocs.length > maxFiles;

    if (toProcess.length === 0) {
      return {
        processed: 0,
        succeeded: 0,
        failed: 0,
        hasMore: false,
        sampleErrors: [],
      };
    }

    console.log(
      `Bulk rescan: caller=${callerEmail} target=${targetUid} processing=${toProcess.length} hasMore=${hasMore}`,
    );

    let succeeded = 0;
    let failed = 0;
    const sampleErrors: string[] = [];
    const apiKey = anthropicApiKey.value();

    // Simple concurrency limiter — chunk the work into waves of PARALLELISM.
    for (let i = 0; i < toProcess.length; i += PARALLELISM) {
      const wave = toProcess.slice(i, i + PARALLELISM);
      const results = await Promise.allSettled(
        wave.map(async (doc) => {
          const fileId = doc.id;
          const fileData = doc.data();

          const wasNotInvoice = fileData.isNotInvoice === true;
          const isUserOverride = wasNotInvoice;

          const resetData: Record<string, unknown> = {
            extractionComplete: false,
            extractionError: null,
            isNotInvoice: null,
            notInvoiceReason: null,
            partnerMatchComplete: false,
            partnerMatchedAt: null,
            partnerSuggestions: [],
            transactionMatchComplete: false,
            transactionMatchedAt: null,
            transactionSuggestions: [],
            updatedAt: Timestamp.now(),
          };
          if (fileData.partnerMatchedBy !== "manual") {
            resetData.partnerId = null;
            resetData.partnerType = null;
            resetData.partnerMatchedBy = null;
            resetData.partnerMatchConfidence = null;
          }

          await db.collection("files").doc(fileId).update(resetData);

          try {
            await runExtraction(fileId, fileData, {
              anthropicApiKey: apiKey,
              skipClassification: isUserOverride,
            });
            return { ok: true as const };
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Unknown extraction error";
            // Persist the new error so the file is recognized as still-errored.
            await db.collection("files").doc(fileId).update({
              extractionComplete: true,
              extractionError: message,
              updatedAt: Timestamp.now(),
            });
            return { ok: false as const, message };
          }
        }),
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value.ok) {
            succeeded++;
          } else {
            failed++;
            if (sampleErrors.length < 5) sampleErrors.push(r.value.message);
          }
        } else {
          failed++;
          const msg =
            r.reason instanceof Error ? r.reason.message : "Unknown error";
          if (sampleErrors.length < 5) sampleErrors.push(msg);
        }
      }
    }

    return {
      processed: toProcess.length,
      succeeded,
      failed,
      hasMore,
      sampleErrors,
    };
  },
);
