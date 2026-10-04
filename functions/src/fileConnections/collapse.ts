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
 * An orphan a paid invoice rests on (its File's invoice is paid by that
 * Transaction) is held back and reported: removing it would turn the invoice
 * back to issued. `revertPaidInvoices` removes it anyway.
 *
 * The app stays live while the pass runs, so each removal is checked again
 * inside a Firestore transaction before it deletes anything: a pair connected
 * since the read, or a kept record gone since, is skipped and reported.
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
  /** Orphans a paid invoice rests on; held back unless `revertPaidInvoices`. */
  paidInvoices: Array<{ invoiceId: string; fileId: string; transactionId: string; held: boolean }>;
  /** Removals the check inside the transaction refused: the data changed since the read. */
  skipped: Array<{ fileId: string; transactionId: string; reason: string }>;
  /** How many removed records share each writer fingerprint. */
  removedByFingerprint: Record<string, number>;
  /** On a dry run, the records to remove; with `apply`, the records removed. */
  removedRecords: number;
}

export interface CollapseOptions {
  apply: boolean;
  /** Remove an orphan a paid invoice rests on too; the invoice goes back to issued. */
  revertPaidInvoices?: boolean;
  /** Called with every record about to be removed, before the first delete. */
  beforeDelete?: (records: Array<{ id: string; data: Data }>) => Promise<void>;
}

/** Records of one pair to remove, and what must still hold when they go. */
interface Removal {
  kind: "orphan" | "duplicate";
  fileId: string;
  transactionId: string;
  docs: QueryDoc[];
  /** A duplicate's kept record, which must still exist. */
  keptId?: string;
  /** An orphan's File invoice, which must not be paid by this Transaction (unless reverting). */
  invoiceId?: string;
}

export async function collapseFileConnections(db: Db, options: CollapseOptions): Promise<CollapseReport> {
  const [recordsSnap, filesSnap, txSnap, invoicesSnap] = await Promise.all([
    db.collection("fileConnections").get(),
    db.collection("files").get(),
    db.collection("transactions").get(),
    db.collection("invoices").get(),
  ]);
  const files = new Map(filesSnap.docs.map((d) => [d.id, d.data()]));
  const txs = new Map(txSnap.docs.map((d) => [d.id, d.data()]));
  const invoices = new Map(invoicesSnap.docs.map((d) => [d.id, d.data()]));
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
    paidInvoices: [],
    skipped: [],
    removedByFingerprint: {},
    removedRecords: 0,
  };
  const removals: Removal[] = [];

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
      const invoiceId = files.get(fileId)?.invoiceId;
      if (typeof invoiceId === "string" && invoiceId && paidBy(invoices.get(invoiceId), transactionId)) {
        const held = options.revertPaidInvoices !== true;
        report.paidInvoices.push({ invoiceId, fileId, transactionId, held });
        if (held) continue;
      }
      removals.push({
        kind: "orphan",
        fileId,
        transactionId,
        docs,
        invoiceId: typeof invoiceId === "string" && invoiceId ? invoiceId : undefined,
      });
      continue;
    }
    if (docs.length > 1) {
      const extra = docs.filter((d) => d.id !== kept.id);
      report.duplicates.push({ kept: summarize(kept), removed: extra.map(summarize) });
      removals.push({ kind: "duplicate", fileId, transactionId, docs: extra, keptId: kept.id });
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

  const planned = removals.flatMap((r) => r.docs);
  if (!options.apply || planned.length === 0) {
    for (const doc of planned) countFingerprint(report, doc);
    report.removedRecords = planned.length;
    return report;
  }

  await options.beforeDelete?.(planned.map((d) => ({ id: d.id, data: d.data() })));
  for (const removal of removals) {
    const outcome = await db.runTransaction((tx) => removeChecked(tx, db, removal, options));
    if (outcome.skipped) {
      report.skipped.push({ fileId: removal.fileId, transactionId: removal.transactionId, reason: outcome.skipped });
      continue;
    }
    for (const doc of outcome.removed) countFingerprint(report, doc);
    report.removedRecords += outcome.removed.length;
  }
  return report;
}

/**
 * One pair's removal, checked against the data as it is now: the pass read
 * it a while ago, and the app kept writing since.
 */
async function removeChecked(
  tx: FirebaseFirestore.Transaction,
  db: Db,
  removal: Removal,
  options: CollapseOptions
): Promise<{ removed: QueryDoc[]; skipped?: string }> {
  const [fileSnap, txSnap, ...recordSnaps] = await tx.getAll(
    db.collection("files").doc(removal.fileId),
    db.collection("transactions").doc(removal.transactionId),
    ...removal.docs.map((d) => d.ref)
  );

  if (removal.kind === "orphan") {
    if (idsOf(fileSnap.data()?.transactionIds).includes(removal.transactionId)) {
      return { removed: [], skipped: "the File lists the Transaction now" };
    }
    if (idsOf(txSnap.data()?.fileIds).includes(removal.fileId)) {
      return { removed: [], skipped: "the Transaction lists the File now" };
    }
    if (removal.invoiceId && options.revertPaidInvoices !== true) {
      const invoice = await tx.get(db.collection("invoices").doc(removal.invoiceId));
      if (paidBy(invoice.data(), removal.transactionId)) {
        return { removed: [], skipped: "a paid invoice rests on it now" };
      }
    }
  } else {
    const kept = await tx.get(db.collection("fileConnections").doc(removal.keptId!));
    if (!kept.exists) return { removed: [], skipped: "the kept record is gone" };
  }

  const removed = removal.docs.filter((_, i) => recordSnaps[i].exists);
  for (const doc of removed) tx.delete(doc.ref);
  return { removed };
}

function paidBy(invoice: Data | undefined, transactionId: string): boolean {
  return invoice?.status === "paid" && invoice.paidByTransactionId === transactionId;
}

function countFingerprint(report: CollapseReport, doc: QueryDoc): void {
  const fp = summarize(doc).fingerprint;
  report.removedByFingerprint[fp] = (report.removedByFingerprint[fp] ?? 0) + 1;
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
