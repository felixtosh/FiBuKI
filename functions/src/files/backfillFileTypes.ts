/**
 * Backfill File Types
 *
 * One-time callable that sets `fileType` on every file record missing one,
 * sniffed from the stored bytes via the same sniffer extraction already uses
 * (#248). Idempotent — skips records that already have a fileType.
 *
 * Sweeps `files` and `receipts` (#282): a receipt carries its own `fileType`,
 * and the sidebar's `classifyFileStrict` has no extension fallback, so a
 * receipt written without one renders with no preview until something repairs
 * it. One pass parameterised over the collection, not a copy per collection —
 * two near-identical backfills are how the pair drifts.
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

interface BackfillCounts {
  updated: number;
  skipped: number;
  /**
   * Records whose object downloaded fine but whose bytes match no magic number.
   * Kept out of `skipped` because it is a materially different outcome for an
   * operator: the blob is there and readable, we simply cannot name it (#281).
   */
  unidentified: number;
}

/** A collection whose documents carry a `fileType` and point at stored bytes. */
interface BackfillTarget {
  collection: "files" | "receipts";
  storagePathField: string;
}

const TARGETS: BackfillTarget[] = [
  { collection: "files", storagePathField: "storagePath" },
  { collection: "receipts", storagePathField: "storagePath" },
];

interface BackfillFileTypesResponse extends BackfillCounts {
  success: boolean;
  /** The top-level counts are these summed; this says where each one came from. */
  byCollection: Record<BackfillTarget["collection"], BackfillCounts>;
}

type Bucket = ReturnType<ReturnType<typeof getStorage>["bucket"]>;

async function backfillCollection(
  db: FirebaseFirestore.Firestore,
  bucket: Bucket,
  userId: string,
  { collection, storagePathField }: BackfillTarget
): Promise<BackfillCounts> {
  const snap = await db.collection(collection).where("userId", "==", userId).get();

  let updated = 0;
  let skipped = 0;
  let unidentified = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const label = `${collection}/${doc.id}`;

    if (data.fileType) {
      skipped++;
      continue;
    }

    const storagePath = data[storagePathField] as string | undefined;
    if (!storagePath) {
      console.warn(`[backfillFileTypes] ${label} has no ${storagePathField}, skipping`);
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
      console.warn(`[backfillFileTypes] ${label} could not be downloaded from ${storagePath}, skipping`, error);
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
      console.warn(`[backfillFileTypes] ${label} at ${storagePath} matched no known magic number, leaving fileType unset`);
      unidentified++;
      continue;
    }

    await doc.ref.update({
      fileType,
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[backfillFileTypes] Set fileType=${fileType} on ${label}`);
    updated++;
  }

  console.log(`[backfillFileTypes] ${collection} done: updated=${updated}, skipped=${skipped}, unidentified=${unidentified}`);
  return { updated, skipped, unidentified };
}

export const backfillFileTypesCallable = createCallable<
  BackfillFileTypesRequest,
  BackfillFileTypesResponse
>(
  { name: "backfillFileTypes" },
  async (ctx) => {
    const bucket = getStorage().bucket();
    const totals: BackfillCounts = { updated: 0, skipped: 0, unidentified: 0 };
    const byCollection = {} as BackfillFileTypesResponse["byCollection"];

    for (const target of TARGETS) {
      const counts = await backfillCollection(ctx.db, bucket, ctx.userId, target);
      byCollection[target.collection] = counts;
      totals.updated += counts.updated;
      totals.skipped += counts.skipped;
      totals.unidentified += counts.unidentified;
    }

    return { success: true, ...totals, byCollection };
  }
);
