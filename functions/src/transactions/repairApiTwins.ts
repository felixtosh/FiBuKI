/**
 * The one-off repair of API twins (#685): the reads and the apply around the
 * pure pairing and plan in apiTwins.ts.
 *
 * `repairApiTwins` runs over one User's Bank Account. For each pair it keeps
 * the CSV row and, through the writers every surface uses, moves the API
 * twin's work onto it: its Partner (assignPartnerToTransactionInternal), its
 * No-document Category (assignNoReceiptCategoryToTransaction) and its File
 * Connections (the File Connection writer: an Unlink without Rejection, then a
 * connect carrying the record's origin and fields). Then the API twin goes
 * the way a deleted import's rows go: detachTransactions, the delete, and the
 * month's Transaction count. Transactions cannot be deleted one by one in the
 * product (accounting integrity); this is maintenance, not a feature.
 *
 * - A dry run unless `apply`. Pairs that need a decision, moves the writer
 *   would refuse, API rows with no twin and groups the name does not pair are
 *   reported and never touched.
 * - The app stays live: on apply, each pair is read and planned again just
 *   before it is merged, and a pair whose plan changed since the dry read is
 *   skipped and reported. A connect the writer refuses anyway puts the File
 *   back on the API twin and stops that pair; the API row is deleted only
 *   inside a transaction that sees it hold no File.
 * - Idempotent: a merged pair has no API row left, so a second run finds
 *   only what it reported the first time.
 *
 * `surveyApiTwins` is read-only over every User: each account with an
 * `api_<13 digits>` import and how many of its rows a CSV import overlaps
 * (#685 open question 2).
 */

import { FieldValue } from "firebase-admin/firestore";
import { connectFiles, detachTransactions, unlinkFile, type ConnectPair } from "../fileConnections/writer";
import { assignPartnerToTransactionInternal } from "../partners/assignPartnerToTransaction";
import { assignNoReceiptCategoryToTransaction } from "../matching/assignNoReceiptCategory";
import { importKind, pairTwins, planTwinMerge, type MergePlan, type TwinRow } from "./apiTwins";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;
interface Doc {
  id: string;
  data: Data;
}

const WHY = "as the twin of the same bank line in a CSV import (#685)";

export type MergeEntry = Extract<MergePlan, { kind: "merge" }> & {
  /** True once applied; false on a dry run. */
  done: boolean;
  /** Moved Files that carry an invoice: its paid state follows the File Connection, check it after the run. */
  invoiceFileIds: string[];
};

export interface RepairReport {
  apply: boolean;
  userId: string;
  sourceId: string;
  /** Rows per `api_<13 digits>` import on this Bank Account, before the run. */
  legacyImports: Record<string, number>;
  merges: MergeEntry[];
  decisions: Array<Extract<MergePlan, { kind: "decision" }>>;
  blocked: Array<Extract<MergePlan, { kind: "blocked" }>>;
  unmatched: string[];
  ambiguous: Array<{ apiIds: string[]; csvIds: string[] }>;
  /** Pairs the apply started and could not finish, and why. Nothing of theirs was deleted. */
  failed: Array<{ apiId: string; csvId: string; step: string; message: string }>;
  /** Pairs whose plan changed between the read and the apply; not touched. */
  skipped: Array<{ apiId: string; csvId: string; reason: string }>;
}

export interface RepairOptions {
  userId: string;
  sourceId: string;
  apply: boolean;
  /** Called once with every row and record the apply may change or delete, before the first write. */
  beforeChange?: (backup: { transactions: Doc[]; fileConnections: Doc[] }) => Promise<void>;
}

/** The Vienna calendar day of a stored date (UTC midnight of that day). */
export function dayOf(value: unknown): string {
  const v = value as { toDate?: () => Date } | Date | string | undefined;
  if (v && typeof (v as { toDate?: unknown }).toDate === "function") return (v as { toDate: () => Date }).toDate().toISOString().slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === "string" ? v.slice(0, 10) : "";
}

function twinRow(doc: Doc): TwinRow {
  return {
    id: doc.id,
    importJobId: typeof doc.data.importJobId === "string" ? doc.data.importJobId : null,
    day: dayOf(doc.data.date),
    amount: typeof doc.data.amount === "number" ? doc.data.amount : NaN,
    name: typeof doc.data.name === "string" ? doc.data.name : "",
  };
}

async function accountRows(db: Db, userId: string, sourceId: string): Promise<Doc[]> {
  const snap = await db.collection("transactions").where("userId", "==", userId).where("sourceId", "==", sourceId).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

async function getDocs(db: Db, collection: string, userId: string, ids: string[]): Promise<Map<string, Data>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Data>();
  if (unique.length === 0) return out;
  const snaps = await db.getAll(...unique.map((id) => db.collection(collection).doc(id)));
  for (const s of snaps) if (s.exists && s.data()?.userId === userId) out.set(s.id, s.data()!);
  return out;
}

/** Everything one pair's plan reads, fresh. */
async function readPair(db: Db, userId: string, apiId: string, csvId: string) {
  const rows = await getDocs(db, "transactions", userId, [apiId, csvId]);
  const api = rows.get(apiId);
  const csv = rows.get(csvId);
  if (!api || !csv) return null;
  const snap = await db
    .collection("fileConnections")
    .where("userId", "==", userId)
    .where("transactionId", "in", [apiId, csvId])
    .get();
  const records = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  const fileIds = [
    ...(api.fileIds ?? []),
    ...(csv.fileIds ?? []),
    ...records.map((r) => r.data.fileId),
  ].filter((id): id is string => typeof id === "string" && !!id);
  const files = await getDocs(db, "files", userId, fileIds);
  const originals = await getDocs(
    db,
    "files",
    userId,
    [...files.values()].map((f) => f.copyOfFileId).filter((id): id is string => typeof id === "string" && !!id)
  );
  return { api: { id: apiId, data: api }, csv: { id: csvId, data: csv }, records, files, originals };
}

export async function repairApiTwins(db: Db, options: RepairOptions): Promise<RepairReport> {
  const { userId, sourceId, apply } = options;
  const rows = await accountRows(db, userId, sourceId);
  const report: RepairReport = {
    apply,
    userId,
    sourceId,
    legacyImports: {},
    merges: [],
    decisions: [],
    blocked: [],
    unmatched: [],
    ambiguous: [],
    failed: [],
    skipped: [],
  };
  for (const r of rows) {
    if (importKind(r.data.importJobId) === "legacy-api") {
      report.legacyImports[r.data.importJobId] = (report.legacyImports[r.data.importJobId] ?? 0) + 1;
    }
  }

  const pairing = pairTwins(rows.map(twinRow));
  report.unmatched = pairing.unmatched;
  report.ambiguous = pairing.ambiguous;

  const planned: Array<{ plan: Extract<MergePlan, { kind: "merge" }>; input: NonNullable<Awaited<ReturnType<typeof readPair>>> }> = [];
  for (const { apiId, csvId } of pairing.pairs) {
    const input = await readPair(db, userId, apiId, csvId);
    if (!input) continue;
    const plan = planTwinMerge(input);
    if (plan.kind === "decision") report.decisions.push(plan);
    else if (plan.kind === "blocked") report.blocked.push(plan);
    else planned.push({ plan, input });
  }

  const entry = (plan: Extract<MergePlan, { kind: "merge" }>, files: Map<string, Data>, done: boolean): MergeEntry => ({
    ...plan,
    done,
    invoiceFileIds: plan.moves.map((m) => m.fileId).filter((id) => typeof files.get(id)?.invoiceId === "string"),
  });

  if (!apply) {
    report.merges = planned.map(({ plan, input }) => entry(plan, input.files, false));
    return report;
  }

  if (planned.length > 0 && options.beforeChange) {
    await options.beforeChange({
      transactions: planned.flatMap(({ input }) => [input.api, input.csv]),
      fileConnections: planned.flatMap(({ input }) => input.records),
    });
  }

  for (const { plan: dryPlan } of planned) {
    const fresh = await readPair(db, userId, dryPlan.apiId, dryPlan.csvId);
    const plan = fresh ? planTwinMerge(fresh) : null;
    if (!fresh || !plan || plan.kind !== "merge" || JSON.stringify(plan) !== JSON.stringify(dryPlan)) {
      report.skipped.push({ apiId: dryPlan.apiId, csvId: dryPlan.csvId, reason: "the pair changed since it was read" });
      continue;
    }
    const failure = await applyTwinMerge(db, userId, plan, fresh.api);
    if (failure) {
      report.failed.push({ apiId: plan.apiId, csvId: plan.csvId, ...failure });
      continue;
    }
    report.merges.push(entry(plan, fresh.files, true));
  }
  return report;
}

/**
 * Carry out one pair's merge. Returns the step that failed, or null. A
 * failure leaves the API row in place, so the next run picks the pair up
 * again; what moved before it stays on the CSV row, where it belongs.
 */
export async function applyTwinMerge(
  db: Db,
  userId: string,
  plan: Extract<MergePlan, { kind: "merge" }>,
  api: Doc
): Promise<{ step: string; message: string } | null> {
  const { apiId, csvId } = plan;
  const fail = (step: string, err: unknown) => ({ step, message: err instanceof Error ? err.message : String(err) });

  if (plan.quota === "transfer") {
    // The bank line was counted with its API twin: the CSV row takes that slot.
    await db.collection("transactions").doc(csvId).update({ quotaExceeded: false, updatedAt: FieldValue.serverTimestamp() });
  }

  if (plan.partner) {
    try {
      await assignPartnerToTransactionInternal({ db, userId }, { transactionId: csvId, ...plan.partner });
    } catch (err) {
      return fail("partner", err);
    }
  }

  if (plan.category) {
    try {
      await assignNoReceiptCategoryToTransaction(db, userId, { transactionId: csvId, ...plan.category });
    } catch (err) {
      return fail("category", err);
    }
  }

  for (const move of plan.moves) {
    const { fileId, origin, ...fields } = move;
    try {
      await unlinkFile(db, userId, { fileId, transactionId: apiId });
    } catch (err) {
      return fail(`unlink ${fileId}`, err);
    }
    const pair: ConnectPair = { fileId, transactionId: csvId, ...fields };
    const [outcome] = await connectFiles(db, userId, [pair], { origin });
    if (outcome.status === "refused") {
      // Put it back where it was, the way it was made.
      const [back] = await connectFiles(db, userId, [{ ...pair, transactionId: apiId }], { origin });
      const restored = back.status === "refused" ? `; putting it back was refused too (${back.reason})` : "";
      return { step: `connect ${fileId}`, message: `refused (${outcome.reason}): ${outcome.message}${restored}` };
    }
  }

  for (const fileId of plan.unlinkOnly) {
    try {
      await unlinkFile(db, userId, { fileId, transactionId: apiId });
    } catch (err) {
      return fail(`unlink ${fileId}`, err);
    }
  }

  // ---- the API twin goes ----
  const current = await db.collection("transactions").doc(apiId).get();
  if (!current.exists) return null;
  const data = current.data()!;
  if (typeof data.noReceiptCategoryId === "string" && data.noReceiptCategoryId) {
    // Its Category counted this row; the CSV row counts the line now.
    const { removeNoReceiptCategory } = await import("../tools/handlers");
    try {
      await removeNoReceiptCategory(userId, apiId);
    } catch (err) {
      return fail("category removal", err);
    }
  }
  await detachTransactions(db, userId, [{ id: apiId, data }], { why: WHY, actor: "manual" });

  const deleted = await db.runTransaction(async (t) => {
    const snap = await t.get(db.collection("transactions").doc(apiId));
    if (!snap.exists) return "gone";
    const fileIds = snap.data()!.fileIds;
    if (Array.isArray(fileIds) && fileIds.length > 0) return "holds a File";
    t.delete(snap.ref);
    return "deleted";
  });
  if (deleted === "holds a File") return { step: "delete", message: "the API row holds a File again" };

  if (deleted === "deleted" && plan.quota === "decrement") await decrementCount(db, userId, api.data.createdAt);
  return null;
}

/**
 * Both twins were counted. The count is per month of import, so the line is
 * taken off only while the count still is the API twin's month; a later month
 * never counted it (a deviation from deleteTransactionsBySource, which takes
 * every deleted row off the current month).
 */
async function decrementCount(db: Db, userId: string, createdAt: unknown): Promise<void> {
  const month = dayOf(createdAt).slice(0, 7);
  if (!month) return;
  const ref = db.collection("subscriptions").doc(userId);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists || snap.data()!.transactionCountMonth !== month) return;
    const current = (snap.data()!.transactionCountCurrentMonth as number) || 0;
    t.update(ref, { transactionCountCurrentMonth: Math.max(0, current - 1), updatedAt: FieldValue.serverTimestamp() });
  });
}

// ============================================================================
// The survey over every User (read-only)
// ============================================================================

export interface SurveyAccount {
  userId: string;
  sourceId: string;
  legacyImports: Record<string, number>;
  apiRows: number;
  /** API rows with a CSV twin. */
  paired: number;
  /** API rows in a day-and-amount group the name does not pair. */
  ambiguous: number;
  /** API rows with no CSV row of their day and amount. */
  unmatched: number;
}

export async function surveyApiTwins(db: Db): Promise<{ accounts: SurveyAccount[] }> {
  // Every `api_…` import id sorts between "api_" and "api_~"; the format is checked after.
  const snap = await db.collection("transactions").where("importJobId", ">=", "api_").where("importJobId", "<", "api_~").get();
  const accounts = new Map<string, { userId: string; sourceId: string }>();
  for (const d of snap.docs) {
    const { userId, sourceId, importJobId } = d.data();
    if (importKind(importJobId) !== "legacy-api" || typeof userId !== "string" || typeof sourceId !== "string") continue;
    accounts.set(`${userId}|${sourceId}`, { userId, sourceId });
  }

  const out: SurveyAccount[] = [];
  for (const { userId, sourceId } of accounts.values()) {
    const rows = await accountRows(db, userId, sourceId);
    const legacyImports: Record<string, number> = {};
    for (const r of rows) {
      if (importKind(r.data.importJobId) === "legacy-api") {
        legacyImports[r.data.importJobId] = (legacyImports[r.data.importJobId] ?? 0) + 1;
      }
    }
    const pairing = pairTwins(rows.map(twinRow));
    out.push({
      userId,
      sourceId,
      legacyImports,
      apiRows: Object.values(legacyImports).reduce((a, b) => a + b, 0),
      paired: pairing.pairs.length,
      ambiguous: pairing.ambiguous.reduce((n, g) => n + g.apiIds.length, 0),
      unmatched: pairing.unmatched.length,
    });
  }
  out.sort((a, b) => (a.userId === b.userId ? a.sourceId.localeCompare(b.sourceId) : a.userId.localeCompare(b.userId)));
  return { accounts: out };
}
