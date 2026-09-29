/**
 * Purge deleted Files — the only act in the product that destroys anything.
 *
 * A Purge takes Files that are already deleted (hidden, ADR-0006), removes
 * the stored bytes and verifies they are gone, then rewrites the record down
 * to the identifying keys deduplication needs — so the next Sync does not
 * import the junk straight back. Everything else about the document is
 * destroyed for good.
 *
 * Reachable from the deleted-files view only (#268), owner-only, and never
 * from the MCP/tool surface. It refuses a File that is not deleted and a
 * FiBuKI-generated invoice document (cancelling an invoice is its own act).
 * The retention warning (BAO § 132) is the confirmation's job in the UI: the
 * user is informed, not gatekept, so this callable does not refuse a
 * retention-relevant Beleg. There is no automatic sweep; soft-deleted Files
 * are otherwise kept indefinitely (#296).
 */

import { Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createCallable, HttpsError } from "../utils/createCallable";
import { generatedInvoiceRefusal } from "./generatedInvoiceGuard";

interface PurgeFilesRequest {
  fileIds: string[];
}

export interface PurgeRefusal {
  fileId: string;
  fileName: string | null;
  reason: "not-found" | "not-deleted" | "generated-invoice" | "storage";
  message: string;
}

interface PurgeFilesResponse {
  success: boolean;
  /** Files destroyed by this call. */
  purged: number;
  /** Files that were already purged — done, not refused. */
  alreadyPurged: number;
  refused: PurgeRefusal[];
}

const MAX_FILES_PER_CALL = 500;

/**
 * The storage path inside a Firebase download URL
 * (`…/o/<url-encoded path>?alt=media…`), or null when the URL is not one.
 * Thumbnails store only their URL, so their path is recovered from it.
 */
export function storagePathFromDownloadUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  const match = url.match(/\/o\/([^?]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Delete one storage object; "already gone" is success. */
async function deleteObject(
  bucket: ReturnType<ReturnType<typeof getStorage>["bucket"]>,
  path: string
): Promise<void> {
  try {
    await bucket.file(path).delete();
  } catch (err) {
    if ((err as { code?: number }).code === 404) return;
    throw err;
  }
}

export const purgeFilesCallable = createCallable<PurgeFilesRequest, PurgeFilesResponse>(
  {
    name: "purgeFiles",
    timeoutSeconds: 300,
  },
  async (ctx, request) => {
    const { fileIds } = request;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new HttpsError("invalid-argument", "fileIds is required");
    }
    if (fileIds.length > MAX_FILES_PER_CALL) {
      throw new HttpsError(
        "invalid-argument",
        `At most ${MAX_FILES_PER_CALL} files can be purged in one call`
      );
    }

    const bucket = getStorage().bucket();
    const refused: PurgeRefusal[] = [];
    let purged = 0;
    let alreadyPurged = 0;

    for (const fileId of fileIds) {
      if (typeof fileId !== "string" || !fileId) {
        refused.push({
          fileId: String(fileId),
          fileName: null,
          reason: "not-found",
          message: "Invalid file id",
        });
        continue;
      }

      const fileRef = ctx.db.collection("files").doc(fileId);
      const snap = await fileRef.get();
      const fileData = snap.data();

      // Ownership reads as existence, as on every other surface.
      if (!snap.exists || !fileData || fileData.userId !== ctx.userId) {
        refused.push({
          fileId,
          fileName: null,
          reason: "not-found",
          message: "File not found",
        });
        continue;
      }

      const fileName = typeof fileData.fileName === "string" ? fileData.fileName : null;

      if (fileData.purgedAt) {
        alreadyPurged++;
        continue;
      }

      if (!fileData.deletedAt) {
        refused.push({
          fileId,
          fileName,
          reason: "not-deleted",
          message:
            "Only a deleted file can be purged. Delete it first; deleting hides it and can still be undone.",
        });
        continue;
      }

      const invoiceRefusal = await generatedInvoiceRefusal(ctx.db, ctx.userId, fileData);
      if (invoiceRefusal) {
        refused.push({
          fileId,
          fileName,
          reason: "generated-invoice",
          message: invoiceRefusal,
        });
        continue;
      }

      // Destroy the bytes, then verify rather than assume: only a document
      // shown to be gone gets its record reduced.
      const storagePath =
        typeof fileData.storagePath === "string" && fileData.storagePath
          ? fileData.storagePath
          : null;
      try {
        if (storagePath) {
          await deleteObject(bucket, storagePath);
          const [stillThere] = await bucket.file(storagePath).exists();
          if (stillThere) {
            throw new Error(`object still exists after delete: ${storagePath}`);
          }
        }
        // Best-effort for the thumbnail: its bytes carry no more than the
        // document's, and account deletion sweeps the prefix anyway.
        const thumbnailPath = storagePathFromDownloadUrl(fileData.thumbnailUrl);
        if (thumbnailPath && thumbnailPath !== storagePath) {
          try {
            await deleteObject(bucket, thumbnailPath);
          } catch (err) {
            console.warn(`[purgeFiles] Could not delete thumbnail ${thumbnailPath}`, err);
          }
        }
      } catch (err) {
        console.error(`[purgeFiles] Storage delete failed for ${fileId}`, err);
        refused.push({
          fileId,
          fileName,
          reason: "storage",
          message: "The stored document could not be destroyed; the file was not purged.",
        });
        continue;
      }

      // Rewrite the record down to the keys that stop a re-import (ADR-0006):
      // the id survives as the document id; message, attachment and content
      // hash keys survive as fields. Nothing of the content does.
      const now = Timestamp.now();
      const skeleton: Record<string, unknown> = {
        userId: ctx.userId,
        deletedAt: fileData.deletedAt,
        purgedAt: now,
        updatedAt: now,
        // Readers index into this, so it stays an (empty) array.
        transactionIds: [],
      };
      for (const key of [
        "contentHash",
        "gmailMessageId",
        "gmailAttachmentId",
        "gmailIntegrationId",
        "inboundMessageId",
      ]) {
        if (fileData[key] !== undefined && fileData[key] !== null) {
          skeleton[key] = fileData[key];
        }
      }
      await fileRef.set(skeleton);
      purged++;
      console.log(`[purgeFiles] Purged file ${fileId}`, { userId: ctx.userId });
    }

    return { success: true, purged, alreadyPurged, refused };
  }
);
