/**
 * Filed records, kept (#564, D11-D16): what was filed for a period, and the
 * Mark as filed and status callables behind the filing view.
 *
 * One document per record, append-only: a corrected filing adds a record and
 * the earlier one stays. The derivation it was filed on is kept beside it, in
 * its own document for the same 1 MiB reason `prepareUvaFiling` gives, so a
 * later run can name the Transactions that moved the figures.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";
import { runUvaForPeriod, assertValidPeriod } from "./uvaPeriodRun";
import { buildUvaFiling, type FilingBlocker } from "../uva/filing";
import { periodKeyOf, snapshotDerivations, type UvaDerivationSnapshot } from "../uva/reconcile";
import { periodBoundaries } from "../uva/rateSet";
import {
  compareWithFiled,
  differsFrom,
  kennzahlValues,
  validateFiledKennzahlen,
  type FiledComparison,
  type FiledRecordSource,
  type UvaFiledRecord,
} from "../uva/filedRecord";
import type { UvaPeriod, UvaReportResult } from "../uva/types";

type Db = FirebaseFirestore.Firestore;

export const FILED_RECORDS = "uvaFiledRecords";
const SNAPSHOT = "snapshot";
/** How many earlier filed periods the handover re-runs, newest first. */
const EARLIER_PERIODS_CHECKED = 8;

export interface StoredFiledRecord extends Omit<UvaFiledRecord, "filedAt"> {
  id: string;
  filedAt: string;
}

function toRecord(id: string, data: FirebaseFirestore.DocumentData): StoredFiledRecord {
  const at = toDateSafe(data.filedAt);
  return {
    id,
    periodKey: data.periodKey,
    period: data.period,
    kennzahlen: data.kennzahlen ?? {},
    calculated: data.calculated ?? {},
    editedByHand: data.editedByHand === true,
    source: data.source,
    filedAt: at ? at.toISOString() : String(data.filedAt ?? ""),
    filedBy: data.filedBy,
    referenceNumber: data.referenceNumber ?? null,
    note: data.note ?? null,
  };
}

/** Every record of one period, oldest first. */
export async function filedHistory(db: Db, userId: string, periodKey: string): Promise<StoredFiledRecord[]> {
  const snap = await db
    .collection(FILED_RECORDS)
    .where("userId", "==", userId)
    .where("periodKey", "==", periodKey)
    .get();
  return snap.docs.map((d) => toRecord(d.id, d.data())).sort((a, b) => a.filedAt.localeCompare(b.filedAt));
}

async function filedSnapshot(db: Db, userId: string, recordId: string): Promise<UvaDerivationSnapshot | null> {
  const doc = await db.collection(FILED_RECORDS).doc(recordId).collection(SNAPSHOT).doc("derivations").get();
  const data = doc.exists ? doc.data() : null;
  return data && data.userId === userId ? (data.snapshot as UvaDerivationSnapshot) : null;
}

/** The blockers a run carries: what Mark as filed and a FinanzOnline submission refuse on. */
export function blockersOf(result: UvaReportResult): FilingBlocker[] {
  return buildUvaFiling({ report: result }).blockers;
}

export function refuseOnBlockers(result: UvaReportResult): void {
  const blockers = blockersOf(result);
  if (blockers.length > 0) {
    throw new HttpsError(
      "failed-precondition",
      `Period ${periodKeyOf(result.period)} has ${blockers.length} blocker(s): ` +
        blockers.map((b) => b.code).join(", ")
    );
  }
}

/**
 * Record a period as filed. `kennzahlen` are the figures actually filed;
 * absent, the run's own figures are. Append-only.
 */
export async function recordFiled(
  db: Db,
  userId: string,
  input: {
    result: UvaReportResult;
    source: FiledRecordSource;
    kennzahlen?: Record<string, number> | null;
    referenceNumber?: string | null;
    note?: string | null;
  }
): Promise<StoredFiledRecord> {
  const period: UvaPeriod = {
    year: input.result.period.year,
    period: input.result.period.period,
    type: input.result.period.type,
  };
  const periodKey = periodKeyOf(period);
  const calculated = kennzahlValues(input.result);
  const kennzahlen = input.kennzahlen ?? calculated;
  const ref = db.collection(FILED_RECORDS).doc();
  const filedAt = Timestamp.now();
  const data = {
    userId,
    periodKey,
    period,
    kennzahlen,
    calculated,
    editedByHand: differsFrom(kennzahlen, calculated),
    source: input.source,
    filedAt,
    filedBy: userId,
    referenceNumber: input.referenceNumber ?? null,
    note: input.note ?? null,
  };
  await ref.set(data);
  await ref
    .collection(SNAPSHOT)
    .doc("derivations")
    .set({ userId, snapshot: snapshotDerivations(input.result) });
  return toRecord(ref.id, data);
}

/** The latest record of a period against a run of it; null when it was never filed. */
export async function compareLatestFiled(
  db: Db,
  userId: string,
  result: UvaReportResult
): Promise<{ latest: StoredFiledRecord; comparison: FiledComparison; history: StoredFiledRecord[] } | null> {
  const history = await filedHistory(db, userId, periodKeyOf(result.period));
  const latest = history[history.length - 1];
  if (!latest) return null;
  const comparison = compareWithFiled(latest, await filedSnapshot(db, userId, latest.id), result);
  return { latest, comparison, history };
}

/**
 * Earlier filed periods, each compared against a fresh run (D16): what the
 * handover of `period` raises. The latest record of each period counts, the
 * newest periods first, at most `EARLIER_PERIODS_CHECKED` of them.
 */
export async function earlierFiledComparisons(db: Db, userId: string, period: UvaPeriod): Promise<FiledComparison[]> {
  const start = periodBoundaries(period).start;
  const snap = await db.collection(FILED_RECORDS).where("userId", "==", userId).get();
  const latestByPeriod = new Map<string, StoredFiledRecord>();
  for (const doc of snap.docs) {
    const r = toRecord(doc.id, doc.data());
    if (!r.period || periodBoundaries(r.period).start >= start) continue;
    const prev = latestByPeriod.get(r.periodKey);
    if (!prev || prev.filedAt < r.filedAt) latestByPeriod.set(r.periodKey, r);
  }
  const records = [...latestByPeriod.values()]
    .sort((a, b) => periodBoundaries(b.period).start.localeCompare(periodBoundaries(a.period).start))
    .slice(0, EARLIER_PERIODS_CHECKED);
  const out: FiledComparison[] = [];
  for (const r of records) {
    const { result } = await runUvaForPeriod(db, userId, r.period);
    out.push(compareWithFiled(r, await filedSnapshot(db, userId, r.id), result));
  }
  return out;
}

// ============================================================================
// Callables
// ============================================================================

interface MarkFiledRequest {
  period: UvaPeriod;
  /** The figures actually filed, cents per Kennzahl. Omitted = as calculated. */
  kennzahlen?: Record<string, number>;
  note?: string;
}

export const markUvaPeriodFiledCallable = createCallable<
  MarkFiledRequest,
  { success: true; record: StoredFiledRecord; comparison: FiledComparison }
>({ name: "markUvaPeriodFiled", memory: "512MiB", timeoutSeconds: 120 }, async (ctx, request) => {
  const period = request?.period;
  assertValidPeriod(period);
  let kennzahlen: Record<string, number> | null = null;
  if (request.kennzahlen !== undefined) {
    const valid = validateFiledKennzahlen(request.kennzahlen);
    if (typeof valid === "string") throw new HttpsError("invalid-argument", valid);
    kennzahlen = valid;
  }
  const note = typeof request.note === "string" ? request.note.slice(0, 1000) : null;

  const { result } = await runUvaForPeriod(ctx.db, ctx.userId, period);
  // A period FiBuKI considers unjustified is never recorded as filed (D17):
  // an unlinked correction or an over-refund has to be resolved first.
  refuseOnBlockers(result);

  const record = await recordFiled(ctx.db, ctx.userId, { result, source: "mark-as-filed", kennzahlen, note });
  const comparison = compareWithFiled(record, snapshotDerivations(result), result);
  return { success: true as const, record, comparison };
});

export const getUvaFiledStatusCallable = createCallable<
  { period: UvaPeriod },
  {
    success: true;
    periodKey: string;
    blockers: FilingBlocker[];
    filed: { latest: StoredFiledRecord; comparison: FiledComparison; history: StoredFiledRecord[] } | null;
    earlierFiledMoved: FiledComparison[];
  }
>({ name: "getUvaFiledStatus", memory: "512MiB", timeoutSeconds: 300 }, async (ctx, request) => {
  const period = request?.period;
  assertValidPeriod(period);
  const { result } = await runUvaForPeriod(ctx.db, ctx.userId, period);
  const earlier = await earlierFiledComparisons(ctx.db, ctx.userId, period);
  return {
    success: true as const,
    periodKey: periodKeyOf(period),
    blockers: blockersOf(result),
    filed: await compareLatestFiled(ctx.db, ctx.userId, result),
    earlierFiledMoved: earlier.filter((c) => c.moved),
  };
});
