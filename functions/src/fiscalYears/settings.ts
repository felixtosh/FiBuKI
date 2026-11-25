/**
 * Fiscal Years (#794, ADR-0018): the settings, the one stretch check, the
 * stored default and the Import skip. No firebase-functions import, so the
 * Next routes that import (TrueLayer) can use it too; the refusals and the
 * change writer live in fiscalYears.ts.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { viennaToday } from "../utils/storedDay";
import { toDateSafe } from "../utils/toDateSafe";

type Db = FirebaseFirestore.Firestore;

/** A month, `YYYY-MM`. */
export type Month = string;

export interface FiscalYearSettings {
  /** The month a fiscal year starts in, 1-12. January by default. */
  startMonth: number;
  /** The first month FiBuKI holds data for. */
  trackedFrom: Month;
  /** The last closed month, or none. */
  closedThrough: Month | null;
}

export type Stretch = "untracked" | "closed" | "open";

/**
 * Who changed the settings: the settings page, an MCP or REST client, the
 * chat, or `initial` for the default stored on the User's first read.
 */
export type FiscalYearsVia = "settings" | "mcp" | "chat" | "initial";

export interface FiscalYearChangeRecord {
  id: string;
  changedBy: string;
  changedAt: string;
  via: FiscalYearsVia;
  /** Null on the `initial` record: nothing was stored before it. */
  previous: FiscalYearSettings | null;
  next: FiscalYearSettings;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function settingsRef(db: Db, userId: string) {
  return db.collection("users").doc(userId).collection("settings").doc("fiscalYears");
}

export function changesRef(db: Db, userId: string) {
  return db.collection("users").doc(userId).collection("fiscalYearChanges");
}

/** Every document Fiscal Years keeps for a User, for account deletion. */
export function fiscalYearsPaths(userId: string): { settings: string; changes: string } {
  return { settings: `users/${userId}/settings/fiscalYears`, changes: `users/${userId}/fiscalYearChanges` };
}

export function isMonth(value: unknown): value is Month {
  return typeof value === "string" && MONTH.test(value);
}

/** The month a stored date (UTC midnight of the Vienna day) or a `YYYY-MM-DD` falls in. */
export function monthOf(date: Date | string): Month {
  const day = typeof date === "string" ? date : date.toISOString();
  return day.slice(0, 7);
}

/** The current Vienna month. */
export function currentMonth(now: Date = new Date()): Month {
  return monthOf(viennaToday(now));
}

/** The month `count` months after `month` (before, when negative). */
export function addMonths(month: Month, count: number): Month {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The first month of the fiscal year `month` falls in. */
export function fiscalYearStart(month: Month, startMonth: number): Month {
  const [y, m] = month.split("-").map(Number);
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, "0")}`;
}

/** A fiscal year's name: `2024` when it starts in January, `2024/25` otherwise. */
export function fiscalYearLabel(month: Month, startMonth: number): string {
  const year = Number(fiscalYearStart(month, startMonth).slice(0, 4));
  return startMonth === 1 ? String(year) : `${year}/${String((year + 1) % 100).padStart(2, "0")}`;
}

/** Which stretch a date is in, for these settings. The one shared check. */
export function stretchOf(settings: FiscalYearSettings, date: Date | string): Stretch {
  const month = monthOf(date);
  if (month < settings.trackedFrom) return "untracked";
  if (settings.closedThrough !== null && month <= settings.closedThrough) return "closed";
  return "open";
}

const PAGE = 50;

/**
 * The first stored Transaction or live File dated in [from, to), as its month,
 * or null. Either bound may be open. A File in the bin (deletedAt) does not
 * count; an undated File never does.
 */
export async function firstDataMonth(db: Db, userId: string, from: Month | null, to: Month | null): Promise<Month | null> {
  const months: Month[] = [];
  for (const [collection, field] of [
    ["transactions", "date"],
    ["files", "extractedDate"],
  ] as const) {
    let query: FirebaseFirestore.Query = db.collection(collection).where("userId", "==", userId);
    if (from) query = query.where(field, ">=", Timestamp.fromDate(new Date(`${from}-01T00:00:00Z`)));
    if (to) query = query.where(field, "<", Timestamp.fromDate(new Date(`${to}-01T00:00:00Z`)));
    query = query.orderBy(field, "asc");
    let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      const snap: FirebaseFirestore.QuerySnapshot = await (last ? query.startAfter(last) : query).limit(PAGE).get();
      const live = snap.docs.find((d) => !(collection === "files" && d.data().deletedAt));
      const date = live ? toDateSafe(live.data()[field]) : null;
      if (date) {
        months.push(monthOf(date));
        break;
      }
      if (snap.size < PAGE) break;
      last = snap.docs[snap.docs.length - 1];
    }
  }
  return months.length > 0 ? months.sort()[0] : null;
}

export function parseStored(data: FirebaseFirestore.DocumentData | undefined): FiscalYearSettings | null {
  if (!data || !isMonth(data.trackedFrom)) return null;
  return {
    startMonth: typeof data.startMonth === "number" ? data.startMonth : 1,
    trackedFrom: data.trackedFrom,
    closedThrough: isMonth(data.closedThrough) ? data.closedThrough : null,
  };
}

/**
 * The default for a User with nothing stored: January, nothing closed, and
 * Tracked From the first month of the current fiscal year, or the first month
 * of the fiscal year holding the User's earliest data when that is earlier, so
 * a User who had data before Fiscal Years existed finds none of it untracked.
 */
async function defaultSettings(db: Db, userId: string): Promise<FiscalYearSettings> {
  const startMonth = 1;
  const current = fiscalYearStart(currentMonth(), startMonth);
  const earliest = await firstDataMonth(db, userId, null, null);
  const earliestYear = earliest ? fiscalYearStart(earliest, startMonth) : null;
  return {
    startMonth,
    trackedFrom: earliestYear && earliestYear < current ? earliestYear : current,
    closedThrough: null,
  };
}

/**
 * The User's settings. The first read stores the default, with an `initial`
 * change record, so it stays what it was on that day.
 */
export async function readFiscalYears(db: Db, userId: string): Promise<FiscalYearSettings> {
  const stored = parseStored((await settingsRef(db, userId).get()).data());
  if (stored) return stored;
  const initial = await defaultSettings(db, userId);
  return db.runTransaction(async (tx) => {
    const again = parseStored((await tx.get(settingsRef(db, userId))).data());
    if (again) return again;
    tx.set(settingsRef(db, userId), { ...initial, updatedAt: FieldValue.serverTimestamp() });
    tx.set(changesRef(db, userId).doc(), {
      userId,
      changedBy: userId,
      changedAt: Timestamp.now(),
      via: "initial",
      previous: null,
      next: initial,
    });
    return initial;
  });
}

export interface UntrackedSplit<T> {
  /** Rows on or after Tracked From: written. */
  tracked: T[];
  /** Rows before Tracked From: not written. */
  untrackedCount: number;
  /** The same rows, counted per fiscal year (`2021`, or `2021/22`). */
  untrackedByFiscalYear: Record<string, number>;
}

/**
 * Split an Import's rows into the ones it writes and the ones before Tracked
 * From, which it skips and counts per fiscal year. Rows in the Closed stretch
 * are written: inserts are never refused.
 */
export async function splitUntracked<T>(
  db: Db,
  userId: string,
  rows: T[],
  dateOf: (row: T) => Date | string
): Promise<UntrackedSplit<T>> {
  const settings = await readFiscalYears(db, userId);
  const tracked: T[] = [];
  const untrackedByFiscalYear: Record<string, number> = {};
  let untrackedCount = 0;
  for (const row of rows) {
    const date = dateOf(row);
    const parsed = typeof date === "string" ? new Date(date) : date;
    if (isNaN(parsed.getTime()) || stretchOf(settings, parsed) !== "untracked") {
      tracked.push(row);
      continue;
    }
    const label = fiscalYearLabel(monthOf(parsed), settings.startMonth);
    untrackedByFiscalYear[label] = (untrackedByFiscalYear[label] ?? 0) + 1;
    untrackedCount++;
  }
  return { tracked, untrackedCount, untrackedByFiscalYear };
}

