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

/**
 * Which stretch a stored date (a Timestamp, a Date, a string) is in, through
 * `stretchOf`; null when the value is not a valid date.
 */
export function stretchOfStored(settings: FiscalYearSettings, value: unknown): Stretch | null {
  const date = toDateSafe(value);
  return date instanceof Date && !isNaN(date.getTime()) ? stretchOf(settings, date) : null;
}

/**
 * The date that puts a File in a stretch: its extracted (or given) date
 * (#801). An undated File is in none, so it is never Closed.
 */
export function fileDateOf(file: Record<string, unknown> | undefined): Date | null {
  const date = toDateSafe(file?.extractedDate);
  return date instanceof Date && !isNaN(date.getTime()) ? date : null;
}

/** Which stretch a File is in, through the one check; null for an undated File. */
export function fileStretchOf(settings: FiscalYearSettings, file: Record<string, unknown> | undefined): Stretch | null {
  const date = fileDateOf(file);
  return date ? stretchOf(settings, date) : null;
}

/**
 * The first month `stretchOf` calls open. The stretches always run untracked,
 * closed, open, so a date is open exactly when it is on or after this month;
 * a query bounds on it to read only open records (#802).
 */
export function openFrom(settings: FiscalYearSettings): Month {
  const afterClosed = settings.closedThrough === null ? settings.trackedFrom : addMonths(settings.closedThrough, 1);
  return afterClosed > settings.trackedFrom ? afterClosed : settings.trackedFrom;
}

/** `openFrom` as a stored date: UTC midnight of its first day. */
export function openFromDate(settings: FiscalYearSettings): Date {
  return new Date(`${openFrom(settings)}-01T00:00:00Z`);
}

/** Automation's view of the stretches, for one User and one run (#803). */
export interface AutomationScope {
  /** Whether automation may work on a record of this date: only in the open stretch. */
  acts(date: unknown): Promise<boolean>;
  /** A Transaction, by its date. */
  actsOnTransaction(data: FirebaseFirestore.DocumentData | undefined): Promise<boolean>;
  /** A File, by its extracted (or given) date. */
  actsOnFile(data: FirebaseFirestore.DocumentData | undefined): Promise<boolean>;
  /** The Transaction documents of a list automation may work on, in order. */
  openTransactions<T extends { data(): FirebaseFirestore.DocumentData | undefined }>(docs: T[]): Promise<T[]>;
}

/**
 * What automation may work on (#803, ADR-0018): records dated in the open
 * stretch. Receipt search, Partner and Category matching, the company lookups,
 * auto-connect and extraction's fact writes leave Closed and Untracked records
 * alone, and a record added into a Closed stretch triggers none of them.
 * Learning does not ask: it may read closed years.
 *
 * An undated record (a File before extraction) is open. The User's settings
 * are read once per scope, on the first dated record, so a run that meets
 * none reads nothing.
 */
export function automationScope(db: Db, userId: string): AutomationScope {
  let settings: Promise<FiscalYearSettings> | null = null;
  const acts = async (date: unknown): Promise<boolean> => {
    const day = toDateSafe(date);
    if (!day || isNaN(day.getTime())) return true;
    settings ??= readFiscalYears(db, userId);
    return stretchOf(await settings, day) === "open";
  };
  return {
    acts,
    actsOnTransaction: (data) => acts(data?.date),
    actsOnFile: (data) => acts(fileDateOf(data)),
    async openTransactions(docs) {
      const open: typeof docs = [];
      for (const doc of docs) if (await acts(doc.data()?.date)) open.push(doc);
      return open;
    },
  };
}

const PAGE = 50;

/**
 * The first stored Transaction or live File dated in [from, to), as its month,
 * or null. Either bound may be open. A File in the bin (deletedAt) does not
 * count; an undated document never does, whichever page it sits on.
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
      // A document in the bin or without a date is skipped on its own: an
      // undated one sorts first and must not hide the dated ones behind it.
      const date = snap.docs
        .filter((d) => !(collection === "files" && d.data().deletedAt))
        .map((d) => toDateSafe(d.data()[field]))
        .find((d): d is Date => d instanceof Date && !isNaN(d.getTime()));
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

/**
 * The User's settings read inside a Firestore transaction, or null when
 * nothing is closed (#801). Reads only, so a writer can ask among its other
 * reads: a User with nothing stored has the default, which closes nothing.
 */
export async function closedSettingsIn(
  tx: FirebaseFirestore.Transaction,
  db: Db,
  userId: string
): Promise<FiscalYearSettings | null> {
  const settings = parseStored((await tx.get(settingsRef(db, userId))).data());
  return settings && settings.closedThrough !== null ? settings : null;
}

/** Whether a stored date lies in the Closed stretch; an unknown date never does. */
export function isClosedDate(settings: FiscalYearSettings | null, date: unknown): boolean {
  if (!settings) return false;
  const parsed = toDateSafe(date);
  return parsed instanceof Date && !isNaN(parsed.getTime()) && stretchOf(settings, parsed) === "closed";
}

/** What a refusal says: Closed Through, and how to lift it. */
export function closedRefusal(settings: FiscalYearSettings, what: string): string {
  return (
    `${what} is dated in a closed month: Closed Through is ${settings.closedThrough}. ` +
    "To change it, move Closed Through back before that month in Settings, Fiscal Years, " +
    "make the change, then move it forward again."
  );
}

/** What a refusal says when a write would land before Tracked From. */
export function untrackedRefusal(settings: FiscalYearSettings, what: string): string {
  return (
    `${what} would be dated before Tracked From ${settings.trackedFrom}, a month FiBuKI does not track. ` +
    "Move Tracked From back first in Settings, Fiscal Years."
  );
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

/** A change of Tracked From (and Closed Through) that brings untracked rows in. */
export interface UntrackedChoice {
  trackedFrom: Month;
  closedThrough?: Month;
}

export interface UntrackedPreview {
  /** Rows before Tracked From: an Import would skip them. */
  untrackedCount: number;
  /** The same rows per fiscal year (`2023`, or `2023/24`). */
  untrackedByFiscalYear: Record<string, number>;
  /**
   * The settings change for each way of bringing them in, for the settings
   * writer, or null when the choice is not offered. Skipping needs none.
   *
   * - closed: Tracked From back to the start of the earliest such fiscal year,
   *   and, while nothing is closed, Closed Through to the month before the old
   *   Tracked From, so every month that was untracked is closed.
   * - open: Tracked From back the same way; only while nothing is closed, as
   *   an open stretch may never lie before a closed one.
   */
  choices: { closed: UntrackedChoice | null; open: UntrackedChoice | null };
}

/**
 * What an Import of rows in these months would skip, and how to bring them
 * in (#805). `months` counts an Import's rows per month (`YYYY-MM`).
 */
export function previewUntracked(settings: FiscalYearSettings, months: Record<Month, number>): UntrackedPreview {
  const untrackedByFiscalYear: Record<string, number> = {};
  let untrackedCount = 0;
  let earliest: Month | null = null;
  for (const [month, count] of Object.entries(months)) {
    if (count <= 0 || stretchOf(settings, `${month}-01`) !== "untracked") continue;
    const label = fiscalYearLabel(month, settings.startMonth);
    untrackedByFiscalYear[label] = (untrackedByFiscalYear[label] ?? 0) + count;
    untrackedCount += count;
    if (earliest === null || month < earliest) earliest = month;
  }
  if (earliest === null) return { untrackedCount, untrackedByFiscalYear, choices: { closed: null, open: null } };

  const trackedFrom = fiscalYearStart(earliest, settings.startMonth);
  const nothingClosed = settings.closedThrough === null;
  return {
    untrackedCount,
    untrackedByFiscalYear,
    choices: {
      closed: nothingClosed ? { trackedFrom, closedThrough: addMonths(settings.trackedFrom, -1) } : { trackedFrom },
      open: nothingClosed ? { trackedFrom } : null,
    },
  };
}

