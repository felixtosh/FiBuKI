/**
 * The Import preview's question (#805, ADR-0018): how many of an Import's rows
 * lie before Tracked From, per fiscal year, and the settings change for each
 * way of bringing them in. Read-only: the Import page sends the chosen change
 * to updateFiscalYears, the one settings writer, and then imports as usual.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";
import {
  fiscalYearLabel,
  isMonth,
  monthOf,
  previewUntracked,
  readFiscalYears,
  stretchOf,
  type UntrackedPreview,
} from "./settings";

type Db = FirebaseFirestore.Firestore;

interface PreviewUntrackedImportRequest {
  /** The Import's rows counted per month, `YYYY-MM` to a count. */
  months: Record<string, number>;
}

const MAX_MONTHS = 1200; // a hundred years of months

export const previewUntrackedImportCallable = createCallable<PreviewUntrackedImportRequest, UntrackedPreview>(
  { name: "previewUntrackedImport" },
  async (ctx, request) => {
    const months = request?.months;
    if (!months || typeof months !== "object" || Array.isArray(months)) {
      throw new HttpsError("invalid-argument", "months must map YYYY-MM to a row count");
    }
    const entries = Object.entries(months);
    if (entries.length > MAX_MONTHS) throw new HttpsError("invalid-argument", "Too many months");
    for (const [month, count] of entries) {
      if (!isMonth(month) || typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        throw new HttpsError("invalid-argument", `months must map YYYY-MM to a row count (${month})`);
      }
    }
    return previewUntracked(await readFiscalYears(ctx.db, ctx.userId), months);
  }
);

/**
 * Files dated before Tracked From (#805). A File is never skipped: its date is
 * known only after extraction. It is kept, left out of the work lists, and
 * surfaced once as one hint ("3 documents from 2021, a year you don't track").
 * The hint counts per fiscal year what was not yet seen; dismissing it stores
 * the counts it showed, so it comes back only for documents that arrive later.
 */
export interface UntrackedFilesHint {
  count: number;
  byFiscalYear: Record<string, number>;
}

export function untrackedFilesHintRef(db: Db, userId: string) {
  return db.collection("users").doc(userId).collection("settings").doc("untrackedFilesHint");
}

/** Live Files dated before Tracked From, counted per fiscal year. */
async function untrackedFilesByFiscalYear(db: Db, userId: string): Promise<Record<string, number>> {
  const settings = await readFiscalYears(db, userId);
  const snap = await db
    .collection("files")
    .where("userId", "==", userId)
    .where("extractedDate", "<", Timestamp.fromDate(new Date(`${settings.trackedFrom}-01T00:00:00Z`)))
    .get();
  const byFiscalYear: Record<string, number> = {};
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.deletedAt) continue;
    const date = toDateSafe(data.extractedDate);
    if (!date || isNaN(date.getTime()) || stretchOf(settings, date) !== "untracked") continue;
    const label = fiscalYearLabel(monthOf(date), settings.startMonth);
    byFiscalYear[label] = (byFiscalYear[label] ?? 0) + 1;
  }
  return byFiscalYear;
}

function seenOf(data: FirebaseFirestore.DocumentData | undefined): Record<string, number> {
  const seen = data?.seen;
  return seen && typeof seen === "object" ? (seen as Record<string, number>) : {};
}

/** What the hint says now: per fiscal year, the documents not yet seen. */
export async function untrackedFilesHint(db: Db, userId: string): Promise<UntrackedFilesHint> {
  const [current, stored] = await Promise.all([
    untrackedFilesByFiscalYear(db, userId),
    untrackedFilesHintRef(db, userId).get(),
  ]);
  const seen = seenOf(stored.data());
  const byFiscalYear: Record<string, number> = {};
  let count = 0;
  for (const [year, total] of Object.entries(current)) {
    const fresh = total - (seen[year] ?? 0);
    if (fresh <= 0) continue;
    byFiscalYear[year] = fresh;
    count += fresh;
  }
  return { count, byFiscalYear };
}

export const getUntrackedFilesHintCallable = createCallable<Record<string, never>, UntrackedFilesHint>(
  { name: "getUntrackedFilesHint" },
  async (ctx) => untrackedFilesHint(ctx.db, ctx.userId)
);

export const dismissUntrackedFilesHintCallable = createCallable<Record<string, never>, { dismissed: boolean }>(
  { name: "dismissUntrackedFilesHint" },
  async (ctx) => {
    const seen = await untrackedFilesByFiscalYear(ctx.db, ctx.userId);
    await untrackedFilesHintRef(ctx.db, ctx.userId).set({ seen, updatedAt: FieldValue.serverTimestamp() });
    return { dismissed: true };
  }
);
