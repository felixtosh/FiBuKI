/**
 * The one-off repair of API twins (#685): the reads and the apply around the
 * pure pairing and plan in apiTwins.ts.
 *
 * `repairApiTwins` runs over one User's Bank Account. For each pair it keeps
 * the CSV row and, through the writers every surface uses, moves the API
 * twin's work onto it: its Partner (assignPartnerToTransactionInternal), its
 * No-document Category (assignNoReceiptCategoryToTransaction) and its File
 * Connections (the File Connection writer: a connect onto the CSV row
 * carrying the record's origin and fields, then an Unlink without Rejection
 * from the API twin). Then the API twin goes the way a deleted import's rows
 * go: detachTransactions, the delete, and the month's Transaction count.
 * Transactions cannot be deleted one by one in the product (accounting
 * integrity); this is maintenance, not a feature.
 *
 * - A dry run unless `apply`. Pairs that need a decision, moves the writer
 *   would refuse, API rows with no twin and groups the name does not pair are
 *   reported and never touched.
 * - An apply merges only what a reviewed dry run listed (`reviewed`), and
 *   only while the pair still plans the same: each pair is read and planned
 *   again just before it is merged.
 * - Every step leaves a state the next run can finish: a File is connected
 *   to the CSV row before it leaves the API twin, so an interruption leaves
 *   it on both (the next run only unlinks it). The API row is deleted only
 *   once neither it, a record nor a File names a File on it, checked before
 *   anything is detached and again inside the delete. A step that throws or
 *   is refused stops that pair, is reported under `failed`, and the run goes
 *   on with the next pair.
 * - Idempotent: a merged pair has no API row left, so a second run finds
 *   only what it reported the first time.
 *
 * `surveyApiTwins` is read-only over every User: each account with an
 * `api_<13 digits>` import and how many of its rows a CSV import overlaps
 * (#685 open question 2).
 */

import { FieldValue } from "firebase-admin/firestore";
import { connectFiles, detachTransactions, unlinkFile, type ConnectPair } from "../fileConnections/writer";
import { ORIGIN_RULES } from "../fileConnections/rules";
import { assignPartnerToTransactionInternal } from "../partners/assignPartnerToTransaction";
import { assignNoReceiptCategoryToTransaction } from "../matching/assignNoReceiptCategory";
import { importKind, pairTwins, planTwinMerge, type MergePlan, type TwinRow } from "./apiTwins";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;
interface Doc {
  id: string;
  data: Data;
}
type Merge = Extract<MergePlan, { kind: "merge" }>;

const WHY = "as the twin of the same bank line in a CSV import (#685)";

export type MergeEntry = Merge & {
  /** True once applied; false on a dry run. */
  done: boolean;
  /**
   * Moved Files that carry an invoice. An invoice the API twin paid is
   * re-pointed to the CSV row by the apply itself; listed so it can be seen.
   */
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
  /** API rows with no day or no finite amount. */
  unpairable: string[];
  /** Pairs the apply started and could not finish, and why. Their API row is still there. */
  failed: Array<{ apiId: string; csvId: string; step: string; message: string }>;
  /** Pairs not merged because they are not in the reviewed dry run or changed since; not touched. */
  skipped: Array<{ apiId: string; csvId: string; reason: string }>;
}

/** What the apply backs up before its first write. Not a full undo: there is no restore tool. */
export interface RepairBackup {
  transactions: Doc[];
  fileConnections: Doc[];
  files: Doc[];
  invoices: Doc[];
  noReceiptCategories: Doc[];
  partners: Doc[];
  subscription: Doc | null;
}

export interface RepairOptions {
  userId: string;
  sourceId: string;
  apply: boolean;
  /** The merges of the reviewed dry run. With `apply`, a pair not in it, or planned differently now, is skipped. */
  reviewed?: Array<Pick<MergeEntry, "apiId" | "csvId"> & Record<string, unknown>>;
  /** Called once with every record the apply may change or delete, before the first write. */
  beforeChange?: (backup: RepairBackup) => Promise<void>;
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
    currency: typeof doc.data.currency === "string" && doc.data.currency ? doc.data.currency : "EUR",
  };
}

async function accountRows(db: Db, userId: string, sourceId: string): Promise<Doc[]> {
  const snap = await db.collection("transactions").where("userId", "==", userId).where("sourceId", "==", sourceId).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/** The imports a CSV upload recorded for this User and Bank Account. */
async function csvImportIds(db: Db, userId: string, sourceId: string): Promise<Set<string>> {
  const snap = await db.collection("imports").where("userId", "==", userId).where("sourceId", "==", sourceId).get();
  return new Set(snap.docs.map((d) => d.id));
}

async function getDocs(db: Db, collection: string, userId: string, ids: unknown[]): Promise<Map<string, Data>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && !!id))];
  const out = new Map<string, Data>();
  if (unique.length === 0) return out;
  const snaps = await db.getAll(...unique.map((id) => db.collection(collection).doc(id)));
  for (const s of snaps) if (s.exists && s.data()?.userId === userId) out.set(s.id, s.data()!);
  return out;
}

const docs = (m: Map<string, Data>): Doc[] => [...m].map(([id, data]) => ({ id, data }));

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
  const files = await getDocs(db, "files", userId, [
    ...(api.fileIds ?? []),
    ...(csv.fileIds ?? []),
    ...records.map((r) => r.data.fileId),
  ]);
  const originals = await getDocs(db, "files", userId, [...files.values()].map((f) => f.copyOfFileId));
  const partners = await getDocs(db, "partners", userId, [api.partnerId]);
  const pointing = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("reconciledByBankTxId", "==", apiId)
    .get();
  const referencedBy = pointing.docs.map((d) => d.id).filter((id) => id !== apiId);
  return { api: { id: apiId, data: api }, csv: { id: csvId, data: csv }, records, files, originals, partners, referencedBy };
}
type PairInput = NonNullable<Awaited<ReturnType<typeof readPair>>>;

/** The plan as a dry run reports it, without the report's own fields, for comparing. */
function planKey(plan: Record<string, unknown>): string {
  const { done: _done, invoiceFileIds: _invoices, ...rest } = plan;
  void _done;
  void _invoices;
  return JSON.stringify(rest);
}

export async function repairApiTwins(db: Db, options: RepairOptions): Promise<RepairReport> {
  const { userId, sourceId, apply } = options;
  const rows = await accountRows(db, userId, sourceId);
  const csvImports = await csvImportIds(db, userId, sourceId);
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
    unpairable: [],
    failed: [],
    skipped: [],
  };
  for (const r of rows) {
    if (importKind(r.data.importJobId, csvImports) === "legacy-api") {
      report.legacyImports[r.data.importJobId] = (report.legacyImports[r.data.importJobId] ?? 0) + 1;
    }
  }

  const pairing = pairTwins(rows.map(twinRow), csvImports);
  report.unmatched = pairing.unmatched;
  report.ambiguous = pairing.ambiguous;
  report.unpairable = pairing.unpairable;

  const planned: Array<{ plan: Merge; input: PairInput }> = [];
  for (const { apiId, csvId } of pairing.pairs) {
    const input = await readPair(db, userId, apiId, csvId);
    if (!input) continue;
    const plan = planTwinMerge(input);
    if (plan.kind === "decision") report.decisions.push(plan);
    else if (plan.kind === "blocked") report.blocked.push(plan);
    else planned.push({ plan, input });
  }

  const entry = (plan: Merge, files: Map<string, Data>, done: boolean): MergeEntry => ({
    ...plan,
    done,
    invoiceFileIds: [...plan.moves.map((m) => m.fileId), ...plan.unlinkOnly].filter(
      (id) => typeof files.get(id)?.invoiceId === "string"
    ),
  });

  if (!apply) {
    report.merges = planned.map(({ plan, input }) => entry(plan, input.files, false));
    return report;
  }

  const reviewed = new Map((options.reviewed ?? []).map((r) => [r.apiId, planKey(r)]));
  const toApply = planned.filter(({ plan }) => {
    const key = reviewed.get(plan.apiId);
    if (key === undefined) {
      report.skipped.push({ apiId: plan.apiId, csvId: plan.csvId, reason: "not in the reviewed dry run" });
      return false;
    }
    if (key !== planKey(plan)) {
      report.skipped.push({ apiId: plan.apiId, csvId: plan.csvId, reason: "planned differently than in the reviewed dry run" });
      return false;
    }
    return true;
  });

  if (toApply.length > 0 && options.beforeChange) {
    await options.beforeChange(await backupOf(db, userId, toApply.map((p) => p.input)));
  }

  for (const { plan: dryPlan } of toApply) {
    let fresh: PairInput | null;
    try {
      fresh = await readPair(db, userId, dryPlan.apiId, dryPlan.csvId);
    } catch (err) {
      report.failed.push({ apiId: dryPlan.apiId, csvId: dryPlan.csvId, step: "read", message: message(err) });
      continue;
    }
    const plan = fresh ? planTwinMerge(fresh) : null;
    if (!fresh || !plan || plan.kind !== "merge" || planKey(plan) !== planKey(dryPlan)) {
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

async function backupOf(db: Db, userId: string, inputs: PairInput[]): Promise<RepairBackup> {
  const files = new Map<string, Data>();
  for (const i of inputs) for (const [id, data] of i.files) files.set(id, data);
  const categoryIds = inputs.flatMap((i) => [i.api.data.noReceiptCategoryId, i.csv.data.noReceiptCategoryId]);
  const partnerIds = inputs.flatMap((i) => [i.api.data.partnerId, i.csv.data.partnerId]);
  const sub = await db.collection("subscriptions").doc(userId).get();
  return {
    transactions: inputs.flatMap((i) => [i.api, i.csv]),
    fileConnections: inputs.flatMap((i) => i.records),
    files: docs(files),
    invoices: docs(await getDocs(db, "invoices", userId, [...files.values()].map((f) => f.invoiceId))),
    noReceiptCategories: docs(await getDocs(db, "noReceiptCategories", userId, categoryIds)),
    partners: docs(await getDocs(db, "partners", userId, partnerIds)),
    subscription: sub.exists ? { id: sub.id, data: sub.data()! } : null,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class StepFailure extends Error {
  constructor(readonly step: string, message: string) {
    super(message);
  }
}

/** Run one step; a throw becomes that step's failure. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StepFailure) throw err;
    throw new StepFailure(name, message(err));
  }
}

/**
 * An invoice the API twin paid is paid by the CSV row now: the same bank
 * line. Set here rather than left to the File Connection triggers, which a
 * script process does not dispatch, and set between the connect and the
 * Unlink, so the triggers, when they do run, find nothing to change.
 */
async function repointInvoice(db: Db, userId: string, fileId: string, apiId: string, csvId: string): Promise<void> {
  const file = await db.collection("files").doc(fileId).get();
  const invoiceId = file.data()?.invoiceId;
  if (typeof invoiceId !== "string" || !invoiceId) return;
  const ref = db.collection("invoices").doc(invoiceId);
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const inv = snap.data();
    if (!snap.exists || inv?.userId !== userId || inv.status !== "paid" || inv.paidByTransactionId !== apiId) return;
    t.update(ref, { paidByTransactionId: csvId, updatedAt: FieldValue.serverTimestamp() });
  });
}

async function setQuotaExceeded(db: Db, transactionId: string, value: boolean): Promise<void> {
  await db.collection("transactions").doc(transactionId).update({ quotaExceeded: value, updatedAt: FieldValue.serverTimestamp() });
}

/**
 * Carry out one pair's merge. Returns the step that failed, or null. A
 * failure leaves the API row in place, so the next run picks the pair up
 * again; what moved before it stays on the CSV row, where it belongs.
 */
export async function applyTwinMerge(
  db: Db,
  userId: string,
  plan: Merge,
  api: Doc
): Promise<{ step: string; message: string } | null> {
  const { apiId, csvId } = plan;
  // A CSV row over quota takes the counted twin's slot. Before the moves
  // only when a move's origin may not connect over quota; otherwise with
  // the delete. Put back if the pair fails, so a rerun plans it the same.
  const slotFirst = plan.quota === "transfer" && plan.moves.some((m) => !ORIGIN_RULES[m.origin].overQuota);
  let slotTaken = false;
  try {
    if (slotFirst) {
      await step("quota", () => setQuotaExceeded(db, csvId, false));
      slotTaken = true;
    }
    if (plan.partner) {
      const partner = plan.partner;
      await step("partner", () => assignPartnerToTransactionInternal({ db, userId }, { transactionId: csvId, ...partner }));
    }
    if (plan.category) {
      const category = plan.category;
      await step("category", () => assignNoReceiptCategoryToTransaction(db, userId, { transactionId: csvId, ...category }));
    }

    for (const move of plan.moves) {
      const { fileId, origin, dropped: _dropped, ...fields } = move;
      void _dropped;
      const pair: ConnectPair = { fileId, transactionId: csvId, ...fields };
      const [outcome] = await step(`connect ${fileId}`, () => connectFiles(db, userId, [pair], { origin }));
      if (outcome.status === "refused") {
        // Nothing left the API twin yet: the File stays where it was.
        throw new StepFailure(`connect ${fileId}`, `refused (${outcome.reason}): ${outcome.message}`);
      }
      await step(`invoice ${fileId}`, () => repointInvoice(db, userId, fileId, apiId, csvId));
      await step(`unlink ${fileId}`, () => unlinkFile(db, userId, { fileId, transactionId: apiId }));
    }
    for (const fileId of plan.unlinkOnly) {
      await step(`invoice ${fileId}`, () => repointInvoice(db, userId, fileId, apiId, csvId));
      await step(`unlink ${fileId}`, () => unlinkFile(db, userId, { fileId, transactionId: apiId }));
    }

    // ---- the API twin goes, only while it holds no File ----
    const current = await step("delete", () => db.collection("transactions").doc(apiId).get());
    if (!current.exists) return null;
    const data = current.data()!;
    const holding = await step("delete", () => filesOn(db, userId, apiId, data));
    if (holding.length > 0) throw new StepFailure("delete", `the API row holds a File again (${holding.join(", ")})`);

    if (typeof data.noReceiptCategoryId === "string" && data.noReceiptCategoryId) {
      // Its Category counted this row; the CSV row counts the line now.
      await step("category removal", async () => {
        const { removeNoReceiptCategory } = await import("../tools/handlers");
        await removeNoReceiptCategory(userId, apiId);
      });
    }
    // Takes the deleted row out of every File's suggestions.
    await step("detach", () => detachTransactions(db, userId, [{ id: apiId, data }], { why: WHY, actor: "manual" }));

    const deleted = await step("delete", () =>
      db.runTransaction(async (t) => {
        const snap = await t.get(db.collection("transactions").doc(apiId));
        if (!snap.exists) return "gone";
        const fileIds = snap.data()!.fileIds;
        if (Array.isArray(fileIds) && fileIds.length > 0) return "holds a File";
        t.delete(snap.ref);
        return "deleted";
      })
    );
    if (deleted === "holds a File") throw new StepFailure("delete", "the API row holds a File again");

    if (deleted === "deleted") {
      if (plan.quota === "transfer" && !slotTaken) await step("quota", () => setQuotaExceeded(db, csvId, false));
      if (plan.quota === "decrement") await step("quota", () => decrementCount(db, userId, api.data.createdAt));
    }
    return null;
  } catch (err) {
    if (slotTaken) {
      try {
        await setQuotaExceeded(db, csvId, true);
      } catch {
        // Reported with the failure below; the rerun then sees no transfer to make.
      }
    }
    const failure = err instanceof StepFailure ? err : new StepFailure("merge", message(err));
    return { step: failure.step, message: failure.message };
  }
}

/** The Files anything still names on the API row: its own list, a record, or a File's list. */
async function filesOn(db: Db, userId: string, apiId: string, data: Data): Promise<string[]> {
  const out = new Set<string>(Array.isArray(data.fileIds) ? data.fileIds.filter((x: unknown) => typeof x === "string") : []);
  const records = await db.collection("fileConnections").where("userId", "==", userId).where("transactionId", "==", apiId).get();
  for (const d of records.docs) out.add(d.data().fileId);
  const listing = await db.collection("files").where("userId", "==", userId).where("transactionIds", "array-contains", apiId).get();
  for (const d of listing.docs) out.add(d.id);
  return [...out];
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
  const none = new Set<string>();
  const accounts = new Map<string, { userId: string; sourceId: string }>();
  for (const d of snap.docs) {
    const { userId, sourceId, importJobId } = d.data();
    if (importKind(importJobId, none) !== "legacy-api" || typeof userId !== "string" || typeof sourceId !== "string") continue;
    accounts.set(`${userId}|${sourceId}`, { userId, sourceId });
  }

  const out: SurveyAccount[] = [];
  for (const { userId, sourceId } of accounts.values()) {
    const rows = await accountRows(db, userId, sourceId);
    const csvImports = await csvImportIds(db, userId, sourceId);
    const legacyImports: Record<string, number> = {};
    for (const r of rows) {
      if (importKind(r.data.importJobId, csvImports) === "legacy-api") {
        legacyImports[r.data.importJobId] = (legacyImports[r.data.importJobId] ?? 0) + 1;
      }
    }
    const pairing = pairTwins(rows.map(twinRow), csvImports);
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
