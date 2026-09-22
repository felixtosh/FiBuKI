/**
 * Backfill File Types
 *
 * One-time callable that sets `fileType` on every file record missing one,
 * sniffed from the stored bytes via the same sniffer extraction already uses
 * (#248). Idempotent — skips files that already have a fileType.
 *
 * Only a magic number is written. Bytes the sniffer cannot name are left with no
 * `fileType` and counted as `unidentified`, because a persisted guess is sticky:
 * it is invisible to the query that finds records needing repair and to the next
 * run of this pass (#281).
 */

import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createCallable } from "../utils/createCallable";
import { sniffMimeTypeStrict } from "../extraction/geminiParser";

interface BackfillFileTypesRequest {
  // empty — operates on all files for the calling user
}

interface BackfillFileTypesResponse {
  success: boolean;
  updated: number;
  skipped: number;
  /**
   * Records whose object downloaded fine but whose bytes match no magic number.
   * Kept out of `skipped` because it is a materially different outcome for an
   * operator: the blob is there and readable, we simply cannot name it (#281).
   */
  unidentified: number;
}

export const backfillFileTypesCallable = createCallable<
  BackfillFileTypesRequest,
  BackfillFileTypesResponse
>(
  { name: "backfillFileTypes" },
  async (ctx) => {
    const filesSnap = await ctx.db
      .collection("files")
      .where("userId", "==", ctx.userId)
      .get();

    const bucket = getStorage().bucket();
    let updated = 0;
    let skipped = 0;
    let unidentified = 0;

    for (const fileDoc of filesSnap.docs) {
      const fileData = fileDoc.data();

      if (fileData.fileType) {
        skipped++;
        continue;
      }

      const storagePath = fileData.storagePath as string | undefined;
      if (!storagePath) {
        console.warn(`[backfillFileTypes] File ${fileDoc.id} has no storagePath, skipping`);
        skipped++;
        continue;
      }

      // One unreadable object must not abort the pass — the criterion is that
      // every record that CAN be sniffed gets a fileType, and the loop is the
      // only chance the rest of them get.
      let buffer: Buffer;
      try {
        [buffer] = await bucket.file(storagePath).download();
      } catch (error) {
        console.warn(`[backfillFileTypes] File ${fileDoc.id} could not be downloaded from ${storagePath}, skipping`, error);
        skipped++;
        continue;
      }

      // Strict, not `sniffMimeType`: that one falls back to image/jpeg for bytes
      // it cannot name, which is fine for a transient extraction call and wrong
      // to persist — it would stamp a guess as a fact, hide the record from the
      // "missing fileType" query that found it, and be skipped by the next run
      // of this very pass (#281). Absent is the honest value.
      const fileType = sniffMimeTypeStrict(buffer);
      if (!fileType) {
        console.warn(`[backfillFileTypes] File ${fileDoc.id} at ${storagePath} matched no known magic number, leaving fileType unset`);
        unidentified++;
        continue;
      }

      await fileDoc.ref.update({
        fileType,
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`[backfillFileTypes] Set fileType=${fileType} on file ${fileDoc.id}`);
      updated++;
    }

    console.log(`[backfillFileTypes] Done: updated=${updated}, skipped=${skipped}, unidentified=${unidentified}`);

    return { success: true, updated, skipped, unidentified };
  }
);
