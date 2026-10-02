/**
 * Read-only views for the plugin widgets: how covered a period is, and the Matches waiting for a
 * yes. Built only from stored data. "Needs a receipt" is the rule listTransactionsNeedingFiles
 * already uses (no file, no No-document Category, not parked on the quota), and a waiting
 * suggestion is the one autoConnectFileSuggestions would connect, so the widgets never disagree
 * with the tools that act. Nothing is scored here.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { dayStartUtc, dayEndExclusiveUtc } from "../uva/dateWindow";

const db = getFirestore();

export const SCAN_CAP = 2000;
export const MISSING_LIST_CAP = 25;
export const DEFAULT_MIN_CONFIDENCE = 85;

interface TransactionRow {
  id: string;
  date?: { toDate?: () => Date } | Date | string | null;
  amount?: number;
  currency?: string;
  name?: string;
  partner?: string | null;
  partnerName?: string | null;
  fileIds?: string[];
  noReceiptCategoryId?: string | null;
  quotaExceeded?: boolean;
}

function dayOf(value: TransactionRow["date"]): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const date = value instanceof Date ? value : value.toDate?.();
  return date && !isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export type TransactionState = "covered" | "missing" | "parked";

export function stateOf(t: TransactionRow): TransactionState {
  if (t.fileIds && t.fileIds.length > 0) return "covered";
  if (t.noReceiptCategoryId) return "covered";
  if (t.quotaExceeded) return "parked";
  return "missing";
}

interface MonthStatus {
  month: string;
  total: number;
  covered: number;
  missing: number;
  parked: number;
  coveragePercent: number;
}

export function summarizeTransactions(transactions: TransactionRow[]) {
  const byMonth = new Map<string, MonthStatus>();
  const missing: Array<Record<string, unknown>> = [];
  let missingCount = 0;

  for (const t of transactions) {
    const day = dayOf(t.date);
    if (!day) continue;
    const month = day.slice(0, 7);
    const row =
      byMonth.get(month) ?? { month, total: 0, covered: 0, missing: 0, parked: 0, coveragePercent: 0 };
    byMonth.set(month, row);

    const state = stateOf(t);
    row.total += 1;
    row[state] += 1;
    if (state === "missing") {
      missingCount += 1;
      if (missing.length < MISSING_LIST_CAP) {
        missing.push({
          id: t.id,
          date: day,
          amount: t.amount ?? 0,
          currency: t.currency ?? "EUR",
          name: t.name ?? null,
          partner: t.partner ?? t.partnerName ?? null,
        });
      }
    }
  }

  const months = [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
  for (const m of months) m.coveragePercent = m.total ? Math.round((m.covered / m.total) * 100) : 100;

  const totals = months.reduce(
    (acc, m) => ({
      total: acc.total + m.total,
      covered: acc.covered + m.covered,
      missing: acc.missing + m.missing,
      parked: acc.parked + m.parked,
    }),
    { total: 0, covered: 0, missing: 0, parked: 0 }
  );

  return {
    months,
    totals: { ...totals, coveragePercent: totals.total ? Math.round((totals.covered / totals.total) * 100) : 100 },
    missing,
    missingTruncated: missingCount > missing.length,
  };
}

interface Suggestion {
  transactionId: string;
  confidence: number;
  preview?: {
    date?: { toDate?: () => Date } | Date | string | null;
    amount?: number;
    currency?: string;
    name?: string;
    partner?: string | null;
  };
}

interface PendingFile {
  id: string;
  fileName?: string;
  extractedPartner?: string | null;
  extractedAmount?: number | null;
  extractedDate?: TransactionRow["date"];
  transactionSuggestions?: Suggestion[];
}

/** Files nobody has connected yet whose best suggestion clears the bar, best first. */
async function loadPendingMatches(userId: string, minConfidence: number) {
  const snapshot = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("transactionMatchComplete", "==", true)
    .get();

  const pending: Array<{ file: PendingFile; best: Suggestion }> = [];
  for (const doc of snapshot.docs) {
    const data = doc.data() as Record<string, unknown> & PendingFile;
    if (data.deletedAt || data.isNotInvoice) continue;
    if (Array.isArray(data.transactionIds) && data.transactionIds.length > 0) continue;
    const best = (data.transactionSuggestions ?? [])
      .filter((s) => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (best) pending.push({ file: { ...data, id: doc.id }, best });
  }
  return pending.sort((a, b) => b.best.confidence - a.best.confidence);
}

export async function getPeriodStatus(userId: string, args: Record<string, unknown>) {
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
  const dateFrom = (args.dateFrom as string | undefined) ?? defaultFrom;
  const dateTo = (args.dateTo as string | undefined) ?? now.toISOString().slice(0, 10);

  const from = dayStartUtc(dateFrom);
  if (!from) throw new Error(`dateFrom must be a calendar day as YYYY-MM-DD, got "${dateFrom}"`);
  const toExclusive = dayEndExclusiveUtc(dateTo);
  if (!toExclusive) throw new Error(`dateTo must be a calendar day as YYYY-MM-DD, got "${dateTo}"`);

  const snapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("date", ">=", Timestamp.fromDate(from))
    .where("date", "<", Timestamp.fromDate(toExclusive))
    .orderBy("date", "desc")
    .limit(SCAN_CAP + 1)
    .get();

  const truncated = snapshot.docs.length > SCAN_CAP;
  const transactions = snapshot.docs
    .slice(0, SCAN_CAP)
    .map((doc) => ({ id: doc.id, ...(doc.data() as Omit<TransactionRow, "id">) }));

  const pending = await loadPendingMatches(userId, DEFAULT_MIN_CONFIDENCE);

  return {
    period: { dateFrom, dateTo },
    ...summarizeTransactions(transactions),
    // Over a window the scan did not finish, the numbers describe the newest rows only.
    truncated,
    waitingSuggestions: { count: pending.length, minConfidence: DEFAULT_MIN_CONFIDENCE },
  };
}

export async function listPendingMatches(userId: string, args: Record<string, unknown>) {
  const minConfidence = Math.min(Math.max((args.minConfidence as number) || DEFAULT_MIN_CONFIDENCE, 0), 100);
  const limit = Math.min(Math.max((args.limit as number) || 20, 1), 50);

  const pending = await loadPendingMatches(userId, minConfidence);
  const matches = pending.slice(0, limit).map(({ file, best }) => ({
    fileId: file.id,
    fileName: file.fileName ?? null,
    filePartner: file.extractedPartner ?? null,
    fileAmount: file.extractedAmount ?? null,
    fileDate: dayOf(file.extractedDate),
    transactionId: best.transactionId,
    transactionName: best.preview?.name ?? null,
    transactionPartner: best.preview?.partner ?? null,
    transactionAmount: best.preview?.amount ?? null,
    transactionCurrency: best.preview?.currency ?? "EUR",
    transactionDate: dayOf(best.preview?.date),
    confidence: best.confidence,
  }));

  return { matches, count: matches.length, total: pending.length, minConfidence };
}
