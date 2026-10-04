/**
 * One-time pass over stored File Connection records (#612, absorbing #597).
 *
 * Before #612 a record had a random id and several writers created one
 * without looking for an existing record, so a pair could hold two, and a
 * record could outlive the id lists it was written with. This pass:
 *
 * - collapses a pair's duplicate records into the earliest one;
 * - removes an orphaned record, one that neither the File's `transactionIds`
 *   nor the Transaction's `fileIds` mentions;
 * - reports, without writing, a record only one list mentions, and a pair
 *   both lists carry with no record at all.
 *
 * Every record it removes or reports carries its writer fingerprint: the
 * stored `connectionType` and `origin` and the set of fields the record holds.
 * Each writer before #612 left its own shape (the MCP tool wrote no match
 * confidence, the matcher a score breakdown, Partner matching match sources
 * without one, a Copy move `movedFromCopyFileId`), so the fingerprints of the
 * removed records name the writer behind them: #597's open question about
 * the confidence-0 burst of 2026-09-30.
 *
 * Idempotent: a second run finds nothing to remove.
 */

import { earliestConnectionRecord } from "./writer";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;
type QueryDoc = FirebaseFirestore.QueryDocumentSnapshot;

export interface ConnectionRecordSummary {
  id: string;
  userId: string | null;
  fileId: string;
  transactionId: string;
  connectionType: string | null;
  origin: string | null;
  matchConfidence: number | null;
  createdAt: string | null;
  /** The writer fingerprint: connectionType, origin and the record's field names. */
  fingerprint: string;
}

export interface CollapseReport {
  apply: boolean;
  recordsScanned: number;
  /** Pairs that held more than one record: the kept one and the ones removed. */
  duplicates: Array<{ kept: ConnectionRecordSummary; removed: ConnectionRecordSummary[] }>;
  /** Records neither id list mentions; removed. */
  orphans: ConnectionRecordSummary[];
  /** Records only one list mentions; reported, not changed. */
  halfListed: Array<ConnectionRecordSummary & { listedBy: "file" | "transaction" }>;
  /** Pairs both lists carry with no record; reported, not changed. */
  unrecorded: Array<{ fileId: string; transactionId: string; userId: string | null }>;
  /** How many removed records share each writer fingerprint. */
  removedByFingerprint: Record<string, number>;
  removedRecords: number;
}

export interface CollapseOptions {
  apply: boolean;
  /** Called with every record about to be removed, before the first delete. */
  beforeDelete?: (records: Array<{ id: string; data: Data }>) => Promise<void>;
}

export async function collapseFileConnections(db: Db, options: CollapseOptions): Promise<CollapseReport> {
  const [recordsSnap, filesSnap, txSnap] = await Promise.all([
    db.collection("fileConnections").get(),
    db.collection("files").get(),
    db.collection("transactions").get(),
  ]);
  const files = new Map(filesSnap.docs.map((d) => [d.id, d.data()]));
  const txs = new Map(txSnap.docs.map((d) => [d.id, d.data()]));
  const listedByFile = (fileId: string, transactionId: string) =>
    idsOf(files.get(fileId)?.transactionIds).includes(transactionId);
  const listedByTx = (fileId: string, transactionId: string) =>
    idsOf(txs.get(transactionId)?.fileIds).includes(fileId);

  const report: CollapseReport = {
    apply: options.apply,
    recordsScanned: recordsSnap.size,
    duplicates: [],
    orphans: [],
    halfListed: [],
    unrecorded: [],
    removedByFingerprint: {},
    removedRecords: 0,
  };
  const toRemove: QueryDoc[] = [];
  const remove = (doc: QueryDoc) => {
    toRemove.push(doc);
    const fp = summarize(doc).fingerprint;
    report.removedByFingerprint[fp] = (report.removedByFingerprint[fp] ?? 0) + 1;
  };

  const byPair = new Map<string, QueryDoc[]>();
  for (const doc of recordsSnap.docs) {
    const { fileId, transactionId, userId } = doc.data();
    if (typeof fileId !== "string" || typeof transactionId !== "string") continue;
    const key = `${userId ?? ""}|${fileId}|${transactionId}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(doc);
  }

  for (const docs of byPair.values()) {
    const kept = earliestConnectionRecord(docs);
    const { fileId, transactionId } = kept.data();
    const byFile = listedByFile(fileId, transactionId);
    const byTx = listedByTx(fileId, transactionId);

    if (!byFile && !byTx) {
      report.orphans.push(...docs.map(summarize));
      docs.forEach(remove);
      continue;
    }
    if (docs.length > 1) {
      const extra = docs.filter((d) => d.id !== kept.id);
      report.duplicates.push({ kept: summarize(kept), removed: extra.map(summarize) });
      extra.forEach(remove);
    }
    if (byFile !== byTx) {
      report.halfListed.push({ ...summarize(kept), listedBy: byFile ? "file" : "transaction" });
    }
  }

  const recorded = new Set(
    recordsSnap.docs.map((d) => `${d.data().fileId}|${d.data().transactionId}`)
  );
  for (const [fileId, data] of files) {
    for (const transactionId of idsOf(data.transactionIds)) {
      if (recorded.has(`${fileId}|${transactionId}`) || !listedByTx(fileId, transactionId)) continue;
      report.unrecorded.push({ fileId, transactionId, userId: typeof data.userId === "string" ? data.userId : null });
    }
  }

  report.removedRecords = toRemove.length;
  if (options.apply && toRemove.length > 0) {
    await options.beforeDelete?.(toRemove.map((d) => ({ id: d.id, data: d.data() })));
    for (let i = 0; i < toRemove.length; i += 400) {
      const batch = db.batch();
      for (const doc of toRemove.slice(i, i + 400)) batch.delete(doc.ref);
      await batch.commit();
    }
  }
  return report;
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function summarize(doc: QueryDoc): ConnectionRecordSummary {
  const data = doc.data();
  const at = data.createdAt as { toDate?: () => Date } | undefined;
  const connectionType = typeof data.connectionType === "string" ? data.connectionType : null;
  const origin = typeof data.origin === "string" ? data.origin : null;
  return {
    id: doc.id,
    userId: typeof data.userId === "string" ? data.userId : null,
    fileId: data.fileId,
    transactionId: data.transactionId,
    connectionType,
    origin,
    matchConfidence: typeof data.matchConfidence === "number" ? data.matchConfidence : null,
    createdAt: typeof at?.toDate === "function" ? at.toDate().toISOString() : null,
    fingerprint: `${connectionType ?? "-"}|${origin ?? "-"}|${Object.keys(data).sort().join(",")}`,
  };
}
