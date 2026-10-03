/**
 * Boot-time reconciliation for the extraction queue (#603).
 *
 * Jobs in `extraction_jobs` survive a restart, so this is not about losing
 * them. It covers a File waiting for its Extraction that has no job at all:
 * a File written before the queue existed (including events in flight at
 * the deploy that introduced it), or one whose job was lost between the
 * File's write and the job's insert. Without a job, nothing would ever
 * extract it, and it would stay `extractionComplete: false` with no error.
 *
 * On boot, create a job for every such File that has none. A File that
 * already has one keeps it, so running this on every replica, every boot,
 * changes nothing twice. Files that already failed carry extractionError +
 * extractionComplete:true and are not picked up.
 */

import { getFirestore } from "./firestore-shim";
import { enqueueExtractionJob } from "./extraction-worker";

export async function resweepPendingExtractions(log: (m: string) => void): Promise<number> {
  const snap = await getFirestore()
    .collection("files")
    .where("extractionComplete", "==", false)
    .get();
  let n = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data || data.deletedAt || data.isFibukiGenerated) continue;
    await enqueueExtractionJob({
      fileId: doc.id,
      userId: data.userId as string,
      skipClassification: false,
      kind: "new",
    });
    n++;
  }
  if (n > 0) log(`extraction resweep: ${n} file(s) awaiting extraction have a job`);
  return n;
}
