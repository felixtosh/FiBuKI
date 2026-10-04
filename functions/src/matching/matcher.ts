/**
 * The one matcher (#613): which File/Transaction pairs are possible, what
 * each pair is scored with, and its Confidence, for every surface and in both
 * directions.
 *
 * Every surface that proposes, ranks or auto-connects a pair calls this
 * module: the upload trigger and "refresh matches", both connect windows, the
 * find-receipt workflow, the chat agent's local search and batch scorer, the
 * MCP score tool, Partner matching, and both re-score paths. It owns
 *
 * - **eligibility**, one rule in one place (`ineligibleReasonOf`,
 *   `hiddenReasonOf`): a deleted or purged File, a Copy, a non-invoice and a
 *   File addressed to someone else are never possible; a rejected pair
 *   (Rejection on either side) and an over-quota Transaction are held back
 *   from suggestions and auto-connect. A User's search lifts the hidden rule
 *   and shows those pairs marked, so a manual pick stays possible; what that
 *   pick does is the File Connection writer's business (#612).
 * - **the date window**: within MATCH_WINDOW_DAYS of the File's date; an
 *   undated File against the UNDATED_RECENT_TRANSACTIONS most recent
 *   Transactions; the hinted or nominated Transaction always. A User's search
 *   lifts it.
 * - **input assembly**: the Partner's aliases, bands and learned weights, what
 *   the Files already on a Transaction explain (the Remainder, #239) and the
 *   ECB rate for a foreign-currency pair (#555). The pure scoring core in
 *   `transactionScoring.ts` is reached only from here.
 *
 * No other code calls the scoring core, filters candidates or computes a
 * date window; `__tests__/scoringInputs-guard.test.ts` fails if one does.
 */

import { Timestamp } from "firebase-admin/firestore";
import { liveCopyIds } from "../files/copyOps";
import { ecbCrossRate, type EcbRateTable } from "../fx/ecbRates";
import { isSameCurrency } from "../fx/fxPlausibility";
import { toDateSafe } from "../utils/toDateSafe";
import { connectFiles, writeConnectionScores, type ConnectionScore } from "../fileConnections/writer";
import { deriveCoverage, filePaymentTotal, isRemainderClosed } from "./coverage";
import { readDismissedTransactionIds } from "./dismissedTransactions";
import { documentedAmountsOf, loadConnectedFiles, type ConnectedFile } from "./documentedAmounts";
import { fileSearchMatches } from "./fileSearch";
import { isFileRejected } from "./rejectedFiles";
import { hasUndocumentedRival, isSameDayEvidence } from "./remainderAutoConnect";
import { loadScoringEcbRates } from "./scoringEcbRates";
import { MATCH_WINDOW_DAYS } from "./matchWindow";
import { matchesTransactionSearch } from "./transactionSearch";
import {
  SCORING_CONFIG,
  buildScoringOptions,
  isRemainderMatch,
  loadPartnerScoringContext,
  scoreTransaction,
  toFileMatchingData,
  toTransactionData,
  type PartnerScoringContext,
  type TransactionMatchScore,
  type TransactionMatchSource,
} from "./transactionScoring";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;
/** A Transaction as the callers hold it: a snapshot, or anything shaped like one. */
type TxDoc = { id: string; data(): Data | undefined };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export { MATCH_WINDOW_DAYS };
const WINDOW_MS = MATCH_WINDOW_DAYS * MS_PER_DAY;

/** An undated File is scored against this many of the User's most recent Transactions. */
export const UNDATED_RECENT_TRANSACTIONS = 200;

/** Cap on the Transactions one window query reads. */
const MAX_WINDOW_TRANSACTIONS = 1000;

/**
 * Cap on the Transactions a User's search reads. Known limit (#183): an
 * amount older than these cannot be found.
 */
const MAX_SEARCH_TRANSACTIONS = 1000;

/** Firestore's limit on the values of an `in` filter. */
const IN_LIMIT = 30;

// ============================================================================
// Eligibility
// ============================================================================

/** Why a File is never matched, in any mode. */
export type IneligibleReason = "deleted" | "copy" | "not-invoice" | "foreign-recipient";

/** Why a pair is held back from suggestions and auto-connect. A User's search shows it, marked. */
export type HiddenReason = "rejected" | "over-quota";

/**
 * A File, stored or not. `id` is null for a File that is not stored yet (the
 * connect dialog's preview), which can be no Copy and carry no Rejection.
 */
export interface MatcherFile {
  id: string | null;
  data: Data;
}

/**
 * Is this File never possible? `isCopy` is whether it is a live Copy
 * (`liveCopyIds`), which needs its original's record to answer.
 */
export function ineligibleReasonOf(data: Data, isCopy: boolean): IneligibleReason | null {
  if (data.deletedAt || data.purgedAt) return "deleted";
  if (isCopy) return "copy";
  if (data.isNotInvoice === true) return "not-invoice";
  // #229: a valid invoice addressed to somebody else is not this User's;
  // confirming the recipient clears the mark and reopens matching.
  if (data.foreignRecipient === true) return "foreign-recipient";
  return null;
}

/**
 * Is this pair held back? A Rejection on either side (both stored shapes,
 * undone ones excluded, fork #102), or an over-quota Transaction.
 */
export function hiddenReasonOf(
  fileId: string | null,
  fileData: Data,
  transactionId: string,
  txData: Data
): HiddenReason | null {
  if (readDismissedTransactionIds(fileData).has(transactionId)) return "rejected";
  if (fileId && isFileRejected(txData, fileId)) return "rejected";
  if (txData.quotaExceeded) return "over-quota";
  return null;
}

/** Each File's ineligibility, in order. One read of the originals for every marked Copy. */
async function ineligibleReasons(db: Db, files: MatcherFile[]): Promise<Array<IneligibleReason | null>> {
  const stored = files.filter((f): f is { id: string; data: Data } => f.id !== null);
  const copies = await liveCopyIds(db, stored);
  return files.map((f) => ineligibleReasonOf(f.data, f.id !== null && copies.has(f.id)));
}

/** The Files that can ever be matched, in order. */
export async function matchableFiles<F extends MatcherFile>(db: Db, files: F[]): Promise<F[]> {
  const reasons = await ineligibleReasons(db, files);
  return files.filter((_, i) => reasons[i] === null);
}

// ============================================================================
// Date window
// ============================================================================

interface WindowContext {
  /** The User's UNDATED_RECENT_TRANSACTIONS most recent Transactions, for an undated File. */
  recentIds: Set<string>;
  /** Transactions a search nominated for this File (#589). */
  nominatedIds?: Set<string>;
}

function fileDateOf(fileData: Data): Date | null {
  return toDateSafe(fileData.extractedDate);
}

/** Is this Transaction within the File's date window? */
function inWindow(fileData: Data, transactionId: string, txData: Data, ctx: WindowContext): boolean {
  // A search already found it relevant, and an invoice paid on a 45-day term
  // is still this File's (#589).
  if (fileData.precisionSearchHint?.transactionId === transactionId) return true;
  if (ctx.nominatedIds?.has(transactionId)) return true;
  const fileDate = fileDateOf(fileData);
  if (!fileDate) return ctx.recentIds.has(transactionId);
  const txDate = toDateSafe(txData.date);
  if (!txDate) return false;
  return Math.abs(txDate.getTime() - fileDate.getTime()) <= WINDOW_MS;
}

/**
 * The span every Transaction in the window of some File dated `dates` falls
 * in, for a caller that bounds a query by it. Null when there are no dates.
 */
export function windowAround(dates: Date[]): { start: Timestamp; end: Timestamp } | null {
  if (dates.length === 0) return null;
  const times = dates.map((d) => d.getTime());
  return {
    start: Timestamp.fromDate(new Date(Math.min(...times) - WINDOW_MS)),
    end: Timestamp.fromDate(new Date(Math.max(...times) + WINDOW_MS)),
  };
}

async function recentTransactionIds(db: Db, userId: string): Promise<Set<string>> {
  const snapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "desc")
    .limit(UNDATED_RECENT_TRANSACTIONS)
    .get();
  return new Set(snapshot.docs.map((d) => d.id));
}

/**
 * Every Transaction in the window of any of these Files: one query over the
 * union of their windows, the most recent ones for an undated File, and each
 * hinted or nominated Transaction wherever it is dated.
 */
async function windowPool(
  db: Db,
  userId: string,
  files: MatcherFile[],
  nominatedIds: Set<string>
): Promise<{ pool: TxDoc[]; ctx: WindowContext }> {
  const byId = new Map<string, TxDoc>();
  const span = windowAround(files.map((f) => fileDateOf(f.data)).filter((d): d is Date => d !== null));

  if (span) {
    const snapshot = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("date", ">=", span.start)
      .where("date", "<=", span.end)
      .orderBy("date", "desc")
      .limit(MAX_WINDOW_TRANSACTIONS)
      .get();
    if (snapshot.size >= MAX_WINDOW_TRANSACTIONS) {
      console.warn(
        `[Matcher] Window for ${files.length} File(s) hit its cap of ${MAX_WINDOW_TRANSACTIONS}; ` +
          "Transactions at its far edge are not scored"
      );
    }
    for (const doc of snapshot.docs) byId.set(doc.id, doc);
  }

  let recentIds = new Set<string>();
  if (files.some((f) => !fileDateOf(f.data))) {
    const snapshot = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .orderBy("date", "desc")
      .limit(UNDATED_RECENT_TRANSACTIONS)
      .get();
    recentIds = new Set(snapshot.docs.map((d) => d.id));
    for (const doc of snapshot.docs) byId.set(doc.id, doc);
  }

  const extraIds = new Set(nominatedIds);
  for (const f of files) {
    const hinted = f.data.precisionSearchHint?.transactionId;
    if (typeof hinted === "string" && hinted) extraIds.add(hinted);
  }
  const missing = [...extraIds].filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const snaps = await db.getAll(...missing.map((id) => db.collection("transactions").doc(id)));
    for (const snap of snaps) {
      if (snap.exists && snap.data()?.userId === userId) byId.set(snap.id, snap);
    }
  }

  return { pool: [...byId.values()], ctx: { recentIds, nominatedIds } };
}

// ============================================================================
// Input assembly and scoring
// ============================================================================

/** One scored pair. `fileId` is null for a File that is not stored yet. */
export interface Match extends TransactionMatchScore {
  fileId: string | null;
  /** Set only in a User's search: the pair is held back from suggestions and auto-connect. */
  hidden?: HiddenReason;
}

/** One Partner scoring context per Partner per run, as the trigger reads it per File. */
function partnerCache(db: Db, userId: string) {
  const cache = new Map<string, Promise<PartnerScoringContext>>();
  return (partnerId: string | null | undefined) => {
    const key = partnerId ?? "";
    if (!cache.has(key)) cache.set(key, loadPartnerScoringContext(db, partnerId, userId));
    return cache.get(key)!;
  };
}

/** The Files on each Transaction other than `fileId`: what it is scored against (#239). */
function withoutFile(
  connected: Map<string, ConnectedFile[]>,
  fileId: string | null
): Map<string, ConnectedFile[]> {
  if (!fileId) return connected;
  const out = new Map<string, ConnectedFile[]>();
  for (const [txId, files] of connected) {
    const rest = files.filter((f) => f.fileId !== fileId);
    if (rest.length > 0) out.set(txId, rest);
  }
  return out;
}

/**
 * The ECB cross rate for a File's currency into a Transaction's, on the
 * Transaction's date (#555). Null for a same-currency pair, an undated
 * Transaction, or a date the table does not reach within its lookback: the
 * static anchor stands in, exactly as the VAT return falls back.
 */
function publishedRateFor(
  ecbRates: EcbRateTable,
  fileCurrency: string | null | undefined,
  txCurrency: string | null | undefined,
  txDate: unknown
): number | null {
  if (ecbRates.days.length === 0 || isSameCurrency(fileCurrency, txCurrency)) return null;
  const date = toDateSafe(txDate);
  if (!date) return null;
  // The stored day is UTC midnight of the Vienna calendar day.
  return ecbCrossRate(ecbRates, fileCurrency, txCurrency, date.toISOString().slice(0, 10))?.rate ?? null;
}

/**
 * Score one File against Transactions: the single place their scoring inputs
 * are assembled (#308, #327). The billing-cycle band is selected per
 * Transaction, since which recurrence a charge belongs to depends on that
 * Transaction's amount, not the File's.
 */
function scoreAgainst(
  fileData: Data,
  transactions: TxDoc[],
  partner: PartnerScoringContext,
  documentedAmounts: Map<string, number>,
  ecbRates: EcbRateTable
): TransactionMatchScore[] {
  const fileMatchingData = toFileMatchingData(fileData);
  return transactions.map((doc) => {
    const txData = doc.data() ?? {};
    const options = buildScoringOptions(partner.effectiveCycles, partner.weights, txData.amount);
    const fxReferenceRate = publishedRateFor(
      ecbRates,
      fileMatchingData.extractedCurrency,
      txData.currency,
      txData.date
    );
    return scoreTransaction(
      fileMatchingData,
      toTransactionData(doc.id, txData, documentedAmounts.get(doc.id)),
      partner.aliases,
      fxReferenceRate == null ? options : { ...options, fxReferenceRate }
    );
  });
}

const byConfidence = (a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence;

// ============================================================================
// Transactions for a File
// ============================================================================

export interface TransactionsForFileOptions {
  /** A User's typed search: lifts the date window and the hidden rule. */
  search?: string;
  /** Transactions to leave out besides the ones the File is already on. */
  excludeTransactionIds?: string[];
  /** Transactions a search nominated for this File (#589): joined to the window. */
  nominatedTransactionIds?: string[];
}

export interface TransactionsForFileResult {
  ineligible: IneligibleReason | null;
  /** Every candidate scored, best first. */
  matches: Match[];
  totalCandidates: number;
  /** Transactions in the File's date window at all, before exclusions and the hidden rule. */
  windowSize: number;
  /** The Files already on each candidate, this one excluded: what the Remainder rule reads. */
  connectedFiles: Map<string, ConnectedFile[]>;
  /** What those Files explain, per candidate (#239). */
  documentedAmounts: Map<string, number>;
}

const NO_TRANSACTIONS = (ineligible: IneligibleReason | null): TransactionsForFileResult => ({
  ineligible,
  matches: [],
  totalCandidates: 0,
  windowSize: 0,
  connectedFiles: new Map(),
  documentedAmounts: new Map(),
});

/**
 * The Transactions a File may be matched with, scored, best first. Without a
 * search: the date window, hidden pairs left out, as the trigger stores and
 * auto-connects. With one: every Transaction the text or amount finds,
 * hidden pairs marked.
 */
export async function transactionsForFile(
  db: Db,
  userId: string,
  file: MatcherFile,
  options: TransactionsForFileOptions = {}
): Promise<TransactionsForFileResult> {
  const [ineligible] = await ineligibleReasons(db, [file]);
  if (ineligible) return NO_TRANSACTIONS(ineligible);

  const search = options.search?.trim() ?? "";
  if (!search) {
    const [result] = await windowMatches(db, userId, [file], [null], options);
    return result;
  }

  const snapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "desc")
    .limit(MAX_SEARCH_TRANSACTIONS)
    .get();
  const excluded = excludedTransactionIds(file, options);
  const candidates = snapshot.docs.filter(
    (doc) => !excluded.has(doc.id) && matchesTransactionSearch(doc.data(), search)
  );
  return scoreFileAgainstPool(db, userId, file, candidates, true);
}

function excludedTransactionIds(file: MatcherFile, options: TransactionsForFileOptions): Set<string> {
  return new Set<string>([
    ...(Array.isArray(file.data.transactionIds) ? file.data.transactionIds : []),
    ...(options.excludeTransactionIds ?? []),
  ]);
}

/**
 * `transactionsForFile` without a search, for many Files at once: one window
 * query, one Partner read per Partner, one rate read. In order.
 */
export async function transactionsForFiles(
  db: Db,
  userId: string,
  files: MatcherFile[],
  options: Omit<TransactionsForFileOptions, "search"> = {}
): Promise<TransactionsForFileResult[]> {
  return windowMatches(db, userId, files, await ineligibleReasons(db, files), options);
}

async function windowMatches(
  db: Db,
  userId: string,
  files: MatcherFile[],
  reasons: Array<IneligibleReason | null>,
  options: Omit<TransactionsForFileOptions, "search">
): Promise<TransactionsForFileResult[]> {
  const matchable = files.filter((_, i) => reasons[i] === null);
  if (matchable.length === 0) return reasons.map((r) => NO_TRANSACTIONS(r));

  const { pool, ctx } = await windowPool(
    db,
    userId,
    matchable,
    new Set(options.nominatedTransactionIds ?? [])
  );
  const [connected, ecbRates] = await Promise.all([
    loadConnectedFiles(pool.map((t) => t.id)),
    loadScoringEcbRates(db, matchable.map((f) => f.data.extractedCurrency), pool),
  ]);
  const partnerFor = partnerCache(db, userId);

  return Promise.all(
    files.map(async (file, i) => {
      if (reasons[i]) return NO_TRANSACTIONS(reasons[i]);
      const excluded = excludedTransactionIds(file, options);
      const inFileWindow = pool.filter((doc) => inWindow(file.data, doc.id, doc.data() ?? {}, ctx));
      const candidates = inFileWindow.filter(
        (doc) =>
          !excluded.has(doc.id) && hiddenReasonOf(file.id, file.data, doc.id, doc.data() ?? {}) === null
      );
      const connectedFiles = withoutFile(connected, file.id);
      const documentedAmounts = documentedAmountsOf(connectedFiles);
      const partner = await partnerFor(file.data.partnerId);
      const matches = scoreAgainst(file.data, candidates, partner, documentedAmounts, ecbRates)
        .map((m): Match => ({ ...m, fileId: file.id }))
        .sort(byConfidence);
      return {
        ineligible: null,
        matches,
        totalCandidates: candidates.length,
        windowSize: inFileWindow.length,
        connectedFiles,
        documentedAmounts,
      };
    })
  );
}

/** Score one File against chosen Transactions, marking held-back pairs when `markHidden`. */
async function scoreFileAgainstPool(
  db: Db,
  userId: string,
  file: MatcherFile,
  candidates: TxDoc[],
  markHidden: boolean
): Promise<TransactionsForFileResult> {
  const [connected, ecbRates, partner] = await Promise.all([
    loadConnectedFiles(candidates.map((t) => t.id), file.id ?? undefined),
    loadScoringEcbRates(db, [file.data.extractedCurrency], candidates),
    loadPartnerScoringContext(db, file.data.partnerId, userId),
  ]);
  const documentedAmounts = documentedAmountsOf(connected);
  const hiddenById = new Map(
    candidates.map((doc) => [doc.id, hiddenReasonOf(file.id, file.data, doc.id, doc.data() ?? {})])
  );
  const matches = scoreAgainst(file.data, candidates, partner, documentedAmounts, ecbRates)
    .map((m): Match => {
      const hidden = markHidden ? hiddenById.get(m.transactionId) : null;
      return hidden ? { ...m, fileId: file.id, hidden } : { ...m, fileId: file.id };
    })
    .sort(byConfidence);
  return {
    ineligible: null,
    matches,
    totalCandidates: candidates.length,
    windowSize: candidates.length,
    connectedFiles: connected,
    documentedAmounts,
  };
}

/**
 * The fields of a File that is not stored yet, read the way a stored one is
 * (#613): every field the scoring core reads, dates sent as ISO strings
 * turned back into Timestamps. Whatever else the caller sends is dropped.
 */
export function unsavedFileData(info: Record<string, unknown>): Data {
  const data: Data = {};
  for (const field of Object.keys(toFileMatchingData({}))) {
    if (!(field in info)) continue;
    const value = info[field];
    data[field] = typeof value === "string" && /Date$/.test(field) ? isoTimestamp(value) : value;
  }
  return data;
}

function isoTimestamp(value: string): Timestamp | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

// ============================================================================
// Files for a Transaction
// ============================================================================

export interface FilesForTransactionResult {
  /** Every candidate scored, best first. */
  matches: Array<Match & { fileId: string }>;
  totalCandidates: number;
  /**
   * Files left out because a Rejection on either side names this pair, in or
   * out of the window; none in a search. The Connect File window lists every
   * File and hides these, so it never reads a Rejection itself.
   */
  rejectedFileIds: string[];
}

/**
 * The Files a Transaction may be matched with, scored, best first: the
 * mirror of `transactionsForFile`, so a pair scores and is eligible the same
 * from either end. The caller has checked that `txDoc` is the User's.
 */
export async function filesForTransaction(
  db: Db,
  userId: string,
  txDoc: TxDoc,
  options: { search?: string } = {}
): Promise<FilesForTransactionResult> {
  const transactionId = txDoc.id;
  const txData = txDoc.data() ?? {};
  const search = options.search?.trim() ?? "";

  // Every File of the User's, narrowed here rather than in the query: an
  // undated File has no extractedDate at all on some records and a null one
  // on others, and no single query reaches both.
  const snapshot = await db.collection("files").where("userId", "==", userId).get();
  const files = await matchableFiles(
    db,
    snapshot.docs
      .map((doc) => ({ id: doc.id as string, data: doc.data() }))
      // Already on this Transaction: the window shows it as connected.
      .filter((f) => !(Array.isArray(f.data.transactionIds) && f.data.transactionIds.includes(transactionId)))
  );

  let candidates: Array<{ id: string; data: Data; hidden: HiddenReason | null }>;
  const rejectedFileIds: string[] = [];
  if (search) {
    candidates = files
      .filter((f) => fileSearchMatches(f.data, search).length > 0)
      .map((f) => ({ ...f, hidden: hiddenReasonOf(f.id, f.data, transactionId, txData) }));
  } else {
    const ctx: WindowContext = {
      recentIds: files.some((f) => !fileDateOf(f.data))
        ? await recentTransactionIds(db, userId)
        : new Set(),
    };
    candidates = files
      .filter((f) => {
        const hidden = hiddenReasonOf(f.id, f.data, transactionId, txData);
        if (hidden === "rejected") rejectedFileIds.push(f.id);
        return hidden === null && inWindow(f.data, transactionId, txData, ctx);
      })
      .map((f) => ({ ...f, hidden: null }));
  }
  if (candidates.length === 0) return { matches: [], totalCandidates: 0, rejectedFileIds };

  // No candidate is on this Transaction, so what its Files explain is the
  // figure the trigger reads with the candidate excluded.
  const [documentedAmounts, ecbRates] = await Promise.all([
    loadConnectedFiles([transactionId]).then(documentedAmountsOf),
    loadScoringEcbRates(db, candidates.map((f) => f.data.extractedCurrency), [txDoc]),
  ]);
  const partnerFor = partnerCache(db, userId);

  const matches = await Promise.all(
    candidates.map(async (f) => {
      const [score] = scoreAgainst(f.data, [txDoc], await partnerFor(f.data.partnerId), documentedAmounts, ecbRates);
      return f.hidden ? { ...score, fileId: f.id, hidden: f.hidden } : { ...score, fileId: f.id };
    })
  );
  return { matches: matches.sort(byConfidence), totalCandidates: candidates.length, rejectedFileIds };
}

// ============================================================================
// Many Files against many Transactions (Partner matching)
// ============================================================================

/**
 * Every eligible pair among these Files and Transactions, within the date
 * window and not held back, scored, best first. The caller chooses the pools
 * (Partner matching: a Partner's open Transactions, its Files and the
 * unassigned ones); which pairs among them are possible is decided here.
 */
export async function pairsAmong(
  db: Db,
  userId: string,
  files: Array<{ id: string; data: Data }>,
  transactions: TxDoc[]
): Promise<Array<Match & { fileId: string }>> {
  const matchable = await matchableFiles(db, files);
  if (matchable.length === 0 || transactions.length === 0) return [];

  const ctx: WindowContext = {
    recentIds: matchable.some((f) => !fileDateOf(f.data))
      ? await recentTransactionIds(db, userId)
      : new Set(),
  };
  const [connected, ecbRates] = await Promise.all([
    loadConnectedFiles(transactions.map((t) => t.id)),
    loadScoringEcbRates(db, matchable.map((f) => f.data.extractedCurrency), transactions),
  ]);
  const partnerFor = partnerCache(db, userId);

  const perFile = await Promise.all(
    matchable.map(async (file) => {
      const excluded = new Set<string>(Array.isArray(file.data.transactionIds) ? file.data.transactionIds : []);
      const candidates = transactions.filter((doc) => {
        if (excluded.has(doc.id)) return false;
        const txData = doc.data() ?? {};
        return (
          hiddenReasonOf(file.id, file.data, doc.id, txData) === null &&
          inWindow(file.data, doc.id, txData, ctx)
        );
      });
      const documentedAmounts = documentedAmountsOf(withoutFile(connected, file.id));
      const partner = await partnerFor(file.data.partnerId);
      return scoreAgainst(file.data, candidates, partner, documentedAmounts, ecbRates).map((m) => ({
        ...m,
        fileId: file.id,
      }));
    })
  );
  return perFile.flat().sort(byConfidence);
}

// ============================================================================
// One named pair
// ============================================================================

export interface PairScore {
  match: Match;
  /** Set when the File is never possible: the score is reported, never acted on. */
  ineligible: IneligibleReason | null;
  /** Set when the pair is held back from suggestions and auto-connect. */
  hidden: HiddenReason | null;
}

/**
 * Score one pair by id, whatever its date (the agent's batch scorer and the
 * MCP score tool name the pair), and say whether it is possible at all. The
 * caller has checked both are the User's.
 */
export async function scorePair(
  db: Db,
  userId: string,
  file: { id: string; data: Data },
  txDoc: TxDoc
): Promise<PairScore> {
  const [ineligible] = await ineligibleReasons(db, [file]);
  const result = await scoreFileAgainstPool(db, userId, file, [txDoc], false);
  return {
    match: result.matches[0],
    ineligible,
    hidden: hiddenReasonOf(file.id, file.data, txDoc.id, txDoc.data() ?? {}),
  };
}

// ============================================================================
// Stored suggestions and auto-connect
// ============================================================================

/** The suggestion shape a File stores in `transactionSuggestions`. */
export interface StoredSuggestion {
  transactionId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  preview: TransactionMatchScore["preview"];
}

/** What a File stores: the best pairs at or above the suggestion threshold, held-back ones never. */
export function storedSuggestionsOf(matches: Match[]): StoredSuggestion[] {
  return suggestedMatches(matches).map((m) => ({
      transactionId: m.transactionId,
      confidence: m.confidence,
      matchSources: m.matchSources,
      preview: m.preview,
    }));
}

function suggestedMatches(matches: Match[]): Match[] {
  return matches
    .filter((m) => !m.hidden && m.confidence >= SCORING_CONFIG.SUGGESTION_THRESHOLD)
    .sort(byConfidence)
    .slice(0, SCORING_CONFIG.MAX_SUGGESTIONS);
}

export interface AutoConnectPick {
  match: Match;
  /** #242: set only for a same-day Remainder auto-connect. */
  autoConnectReason?: "remainder_same_day";
}

/** Why a match at the auto-connect threshold stays a suggestion; logged by the trigger. */
export interface AutoConnectRefusal {
  transactionId: string;
  confidence: number;
  reason: string;
}

/**
 * Which of a File's matches it connects itself (the upload trigger's rules):
 * at AUTO_MATCH_THRESHOLD, not on a Transaction already documented, a
 * Remainder Match only as the same-day case (#242, ADR-0008), and nothing at
 * all when the File's Partner prefers no receipt at least as strongly.
 */
export async function selectAutoConnects(
  db: Db,
  file: MatcherFile,
  result: TransactionsForFileResult
): Promise<{ picks: AutoConnectPick[]; refusals: AutoConnectRefusal[] }> {
  let potential = suggestedMatches(result.matches).filter(
    (m) => m.confidence >= SCORING_CONFIG.AUTO_MATCH_THRESHOLD
  );
  const refusals: AutoConnectRefusal[] = [];

  if (potential.length > 0 && file.data.partnerId) {
    try {
      const partnerDoc = await db.collection("partners").doc(file.data.partnerId).get();
      const pref = partnerDoc.exists ? partnerDoc.data()!.resolutionPreference : null;
      if (pref?.type === "no_receipt" && pref.confidence > 0 && pref.confidence >= potential[0].confidence) {
        for (const m of potential) {
          refusals.push({
            transactionId: m.transactionId,
            confidence: m.confidence,
            reason: `the Partner prefers no receipt (${pref.confidence}%)`,
          });
        }
        potential = [];
      }
    } catch (err) {
      console.warn("[Matcher] Failed to check partner resolution preference:", err);
    }
  }

  const fileMatchingData = toFileMatchingData(file.data);
  // What the bank was charged for this File, the figure a Remainder is closed
  // with (#172's Trinkgeld included, as the scorer counts it).
  const candidatePayment = filePaymentTotal(
    fileMatchingData.extractedAmount,
    fileMatchingData.extractedTipAmount
  );
  const holdsFiles = (transactionId: string) => result.connectedFiles.has(transactionId);
  const picks: AutoConnectPick[] = [];

  for (const match of potential) {
    const coverage = deriveCoverage(
      match.preview.amount,
      result.documentedAmounts.get(match.transactionId) ?? 0
    );
    if (coverage.isCovered) {
      // Prevents over-matching, e.g. six monthly invoices onto one line.
      refusals.push({
        transactionId: match.transactionId,
        confidence: match.confidence,
        reason:
          `already covered by its Files: ${(coverage.documentedAmount / 100).toFixed(2)} / ` +
          `${(coverage.transactionAmount / 100).toFixed(2)}`,
      });
      continue;
    }
    if (!isRemainderMatch(match)) {
      picks.push({ match });
      continue;
    }
    // #239 left every Remainder Match a suggestion: it claims a split the
    // User has not confirmed. #242 opens one case: the documents are from the
    // same day, the File closes what is open, and no Transaction holding
    // nothing wants this File at least as much. See ADR-0008.
    const connected = result.connectedFiles.get(match.transactionId) ?? [];
    const sameDay = isSameDayEvidence(
      file.data.extractedDate,
      connected.map((f) => f.extractedDate)
    );
    // A Remainder Match is one JUDGED against the Remainder, found wanting
    // too; a Confidence built from date, Partner and invoice number alone
    // must not connect a File that explains none of what is open.
    const closes =
      candidatePayment != null && isRemainderClosed(coverage.remainder - Math.abs(candidatePayment));
    const rival = sameDay && closes && hasUndocumentedRival(match, result.matches, holdsFiles);
    if (sameDay && closes && !rival) {
      picks.push({ match, autoConnectReason: "remainder_same_day" });
      continue;
    }
    refusals.push({
      transactionId: match.transactionId,
      confidence: match.confidence,
      reason: !sameDay
        ? "scored against its Remainder, not same-day evidence"
        : !closes
          ? "scored against its Remainder, does not close it"
          : "scored against its Remainder, an undocumented Transaction scores at least as well",
    });
  }

  return { picks, refusals };
}

/**
 * Connect the picks through the File Connection writer (#612): automated
 * origin, so a rejected or over-quota pair is refused there too and only the
 * email domain is learned. Returns the picks that connected.
 */
export async function autoConnect(
  db: Db,
  userId: string,
  fileId: string,
  picks: AutoConnectPick[]
): Promise<AutoConnectPick[]> {
  if (picks.length === 0) return [];
  const outcomes = await connectFiles(
    db,
    userId,
    picks.map(({ match, autoConnectReason }) => ({
      fileId,
      transactionId: match.transactionId,
      matchSources: match.matchSources,
      matchConfidence: match.confidence,
      scoreBreakdown: match.breakdown,
      ...(autoConnectReason ? { autoConnectReason } : {}),
    })),
    { origin: "auto" }
  );
  return picks.filter((_, i) => outcomes[i].status === "connected");
}

// ============================================================================
// Re-scoring connected pairs
// ============================================================================

/**
 * Re-score the File Connections on a Partner's Transactions after its
 * billing cycle is learned or changes (yazzbert/FiBuKI-selfhost#168), so the
 * right charge for a same-amount recurring document ranks highest. Scored
 * with the Partner's own context and against the full amount, at the ECB
 * rate (#555). Which Files are connected is never touched.
 */
export async function rescoreConnections(
  db: Db,
  userId: string,
  partnerId: string,
  txDocs: TxDoc[]
): Promise<{ rescored: number }> {
  if (txDocs.length === 0) return { rescored: 0 };

  const txById = new Map(txDocs.map((doc) => [doc.id, doc]));
  const txIds = [...txById.keys()];

  const connections: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (let i = 0; i < txIds.length; i += IN_LIMIT) {
    const snapshot = await db
      .collection("fileConnections")
      .where("transactionId", "in", txIds.slice(i, i + IN_LIMIT))
      .where("userId", "==", userId)
      .get();
    connections.push(...snapshot.docs);
  }
  if (connections.length === 0) return { rescored: 0 };

  const fileIds = [...new Set(connections.map((c) => c.data().fileId as string))];
  const filesById = new Map<string, Data>();
  for (let i = 0; i < fileIds.length; i += IN_LIMIT) {
    const snapshot = await db
      .collection("files")
      .where("__name__", "in", fileIds.slice(i, i + IN_LIMIT))
      .get();
    for (const doc of snapshot.docs) filesById.set(doc.id, doc.data());
  }

  const [partner, ecbRates] = await Promise.all([
    loadPartnerScoringContext(db, partnerId, userId),
    loadScoringEcbRates(db, [...filesById.values()].map((f) => f.extractedCurrency), txDocs),
  ]);

  const scores: ConnectionScore[] = [];
  for (const connectionDoc of connections) {
    const { transactionId, fileId } = connectionDoc.data();
    const txDoc = txById.get(transactionId);
    const fileData = filesById.get(fileId);
    if (!txDoc || !fileData) continue;
    const [result] = scoreAgainst(fileData, [txDoc], partner, new Map(), ecbRates);
    scores.push({
      connectionId: connectionDoc.id,
      matchConfidence: result.confidence,
      scoreBreakdown: result.breakdown,
      matchSources: result.matchSources,
    });
  }

  // Written by the File Connection writer (#612), the records' one writer.
  const rescored = await writeConnectionScores(db, scores);
  console.log(`[Matcher] Re-scored ${rescored} connection(s) for partner ${partnerId}`);
  return { rescored };
}
