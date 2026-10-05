/**
 * The one-time repair for #644: re-score every File Connection the
 * billing-cycle re-score wrote (it carries `rescoredAt`), now that the matcher
 * judges a connected pair by the Files beside it rather than by itself.
 * Before the fix such a pair was read as a duplicate of its own invoice and
 * stored confidence 0.
 *
 * Scored by the matcher exactly as the re-score scores (`scoreConnectionRecords`:
 * the Transaction's Partner, the full amount, the ECB rate) and written only
 * through the File Connection writer's `writeConnectionScores` (#612). Which
 * Files are connected is never touched.
 *
 * Idempotent: a record whose stored score already equals the fresh one is not
 * written, so a second run writes nothing. A dry run unless `apply`.
 */

import type { Firestore } from "firebase-admin/firestore";
import { writeConnectionScores, type ConnectionScore } from "../fileConnections/writer";
import { scoreConnectionRecords } from "./matcher";

type Data = FirebaseFirestore.DocumentData;
type Doc = { id: string; data(): Data };

const IN_LIMIT = 30;

export interface RepairedScore {
  connectionId: string;
  userId: string;
  fileId: string;
  transactionId: string;
  from: number | null;
  to: number;
}

export interface RepairRescoredReport {
  apply: boolean;
  /** Records carrying `rescoredAt`. */
  recordsScanned: number;
  /** Their fresh score differs from the stored one: written with `apply`, else would be. */
  changed: RepairedScore[];
  /** Of those, stored at 0 and now above it: the records the bug wrote. */
  raisedFromZero: number;
  unchanged: number;
  /** Not scored: the Transaction or File is gone or not the record's User's. */
  skipped: Array<{ connectionId: string; reason: string }>;
  written: number;
}

/** JSON with object keys sorted: a stored record need not keep the order it was written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

const sameScore = (stored: Data, fresh: ConnectionScore) =>
  stored.matchConfidence === fresh.matchConfidence &&
  canonical(stored.scoreBreakdown) === canonical(fresh.scoreBreakdown) &&
  canonical(stored.matchSources) === canonical(fresh.matchSources);

async function readByIds(db: Firestore, collection: string, ids: string[]): Promise<Map<string, Doc>> {
  const out = new Map<string, Doc>();
  for (let i = 0; i < ids.length; i += IN_LIMIT) {
    const snapshot = await db
      .collection(collection)
      .where("__name__", "in", ids.slice(i, i + IN_LIMIT))
      .get();
    for (const doc of snapshot.docs) out.set(doc.id, doc);
  }
  return out;
}

export async function repairRescoredConnections(
  db: Firestore,
  options: { apply: boolean }
): Promise<RepairRescoredReport> {
  const all = await db.collection("fileConnections").get();
  const records = all.docs.filter((doc) => doc.data().rescoredAt != null);

  const report: RepairRescoredReport = {
    apply: options.apply,
    recordsScanned: records.length,
    changed: [],
    raisedFromZero: 0,
    unchanged: 0,
    skipped: [],
    written: 0,
  };
  if (records.length === 0) return report;

  const txById = await readByIds(db, "transactions", [
    ...new Set(records.map((r) => r.data().transactionId as string).filter(Boolean)),
  ]);

  // One group per User and Partner: the re-score scored with the Partner's context.
  type Group = { userId: string; partnerId: string | null; txDocs: Map<string, Doc>; records: Doc[] };
  const groups = new Map<string, Group>();
  for (const record of records) {
    const { userId, transactionId } = record.data();
    const txDoc = txById.get(transactionId);
    if (!txDoc || !userId || txDoc.data().userId !== userId) {
      report.skipped.push({ connectionId: record.id, reason: "transaction-missing" });
      continue;
    }
    const partnerId = (txDoc.data().partnerId as string | undefined) ?? null;
    const key = `${userId}\u0000${partnerId ?? ""}`;
    const group: Group = groups.get(key) ?? { userId, partnerId, txDocs: new Map(), records: [] };
    group.txDocs.set(txDoc.id, txDoc);
    group.records.push(record);
    groups.set(key, group);
  }

  const toWrite: ConnectionScore[] = [];
  for (const group of groups.values()) {
    const scores = await scoreConnectionRecords(
      db,
      group.userId,
      group.partnerId,
      [...group.txDocs.values()],
      group.records
    );
    const byId = new Map(scores.map((s) => [s.connectionId, s]));
    for (const record of group.records) {
      const fresh = byId.get(record.id);
      const stored = record.data();
      if (!fresh) {
        report.skipped.push({ connectionId: record.id, reason: "file-missing" });
        continue;
      }
      if (sameScore(stored, fresh)) {
        report.unchanged++;
        continue;
      }
      const from = typeof stored.matchConfidence === "number" ? stored.matchConfidence : null;
      if (from === 0 && fresh.matchConfidence > 0) report.raisedFromZero++;
      report.changed.push({
        connectionId: record.id,
        userId: group.userId,
        fileId: stored.fileId,
        transactionId: stored.transactionId,
        from,
        to: fresh.matchConfidence,
      });
      toWrite.push(fresh);
    }
  }

  // Written by the File Connection writer (#612), the records' one writer.
  if (options.apply && toWrite.length > 0) report.written = await writeConnectionScores(db, toWrite);
  return report;
}
