/**
 * Boot-time reconciliation for the trigger queue's one durability gap: the
 * change bus is in-memory, so a restart (deploy, crash, OOM) loses every
 * queued-but-undelivered trigger. For most triggers the next write re-fires
 * them; file extraction has no second chance — extractFileData fires on
 * CREATE, and the update variant only covers undelete — so a file whose
 * created-event died with the process stays extractionComplete:false forever
 * with no error recorded.
 *
 * On boot, re-emit a synthetic created-change for every file still awaiting
 * extraction. extractFileData's own guards (extractionComplete, deletedAt,
 * isFibukiGenerated) make delivery idempotent; files that already failed
 * carry extractionError + extractionComplete:true and are not re-queued.
 */

import { getFirestore } from "./firestore-shim";
import { emitChange } from "./bus";

export async function resweepPendingExtractions(log: (m: string) => void): Promise<number> {
  const snap = await getFirestore()
    .collection("files")
    .where("extractionComplete", "==", false)
    .get();
  let n = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!data || data.deletedAt || data.isFibukiGenerated) continue;
    emitChange({
      collectionPath: "files",
      id: doc.id,
      path: `files/${doc.id}`,
      before: undefined,
      after: data,
    });
    n++;
  }
  if (n > 0) log(`extraction resweep: re-queued ${n} file(s) awaiting extraction`);
  return n;
}
