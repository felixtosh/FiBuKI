/**
 * Fiscal Years (#794, spec #800, ADR-0018).
 *
 * Three values per User, each with the month as its unit, split time into
 * three stretches, always in this order and with no gaps:
 *
 *   Untracked  before Tracked From. Imports skip it.
 *   Closed     Tracked From through Closed Through. Stored, but changes and
 *              deletes are refused; inserts are not.
 *   Open       after that. Normal work.
 *
 * `stretchOf` is the one "which stretch is this date in" check. Every guard
 * and every skip calls it, through `readFiscalYears` for the User's values.
 *
 * Stored at users/{uid}/settings/fiscalYears, written only here (the browser
 * reads it, ADR-0016). Every change appends one record to `fiscalYearChanges`,
 * which nothing ever updates.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
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

/** Who changed the settings: the settings page, an MCP or REST client, or the chat. */
export type FiscalYearsVia = "settings" | "mcp" | "chat";

export interface FiscalYearChangeRecord {
  id: string;
  changedBy: string;
  changedAt: string;
  via: FiscalYearsVia;
  previous: FiscalYearSettings;
  next: FiscalYearSettings;
}

export const FISCAL_YEAR_CHANGES = "fiscalYearChanges";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function settingsRef(db: Db, userId: string) {
  return db.collection("users").doc(userId).collection("settings").doc("fiscalYears");
}

export function isMonth(value: unknown): value is Month {
  return typeof value === "string" && MONTH.test(value);
}

/** The month a stored date (UTC midnight of the Vienna day) or a `YYYY-MM-DD` falls in. */
export function monthOf(date: Date | string): Month {
  const day = typeof date === "string" ? date : date.toISOString();
  return day.slice(0, 7);
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

/** The earliest month the User holds a Transaction or a dated File in, or null. */
async function earliestDataMonth(db: Db, userId: string): Promise<Month | null> {
  const months: Month[] = [];
  for (const [collection, field] of [
    ["transactions", "date"],
    ["files", "extractedDate"],
  ] as const) {
    const snap = await db.collection(collection).where("userId", "==", userId).orderBy(field, "asc").limit(1).get();
    const date = snap.empty ? null : toDateSafe(snap.docs[0].data()[field]);
    if (date) months.push(monthOf(date));
  }
  return months.length > 0 ? months.sort()[0] : null;
}

/**
 * The User's settings. With none stored: January, nothing closed, and Tracked
 * From the first month of the current fiscal year, or the earliest month the
 * User already holds data for when that is earlier, so a User who had data
 * before Fiscal Years existed finds none of it untracked.
 */
export async function readFiscalYears(db: Db, userId: string): Promise<FiscalYearSettings> {
  const snap = await settingsRef(db, userId).get();
  const data = snap.exists ? snap.data() : undefined;
  if (data && isMonth(data.trackedFrom)) {
    return {
      startMonth: typeof data.startMonth === "number" ? data.startMonth : 1,
      trackedFrom: data.trackedFrom,
      closedThrough: isMonth(data.closedThrough) ? data.closedThrough : null,
    };
  }
  const current = fiscalYearStart(monthOf(viennaToday()), 1);
  const earliest = await earliestDataMonth(db, userId);
  return {
    startMonth: 1,
    trackedFrom: earliest && earliest < current ? earliest : current,
    closedThrough: null,
  };
}

/** What a refusal says: Closed Through, and how to lift it. */
export function closedRefusal(settings: FiscalYearSettings, what: string): string {
  return (
    `${what} is dated in a closed month: Closed Through is ${settings.closedThrough}. ` +
    "To change it, move Closed Through back before that month (Settings, Fiscal Years, or the set_fiscal_years tool), " +
    "make the change, then move it forward again."
  );
}

/**
 * Refuse when any of these dates lies in the Closed stretch. `what` names the
 * record in the message ("This Transaction").
 */
export async function assertNotClosed(
  db: Db,
  userId: string,
  dates: Array<Date | null | undefined>,
  what: string
): Promise<void> {
  const known = dates.filter((d): d is Date => d instanceof Date && !isNaN(d.getTime()));
  if (known.length === 0) return;
  const settings = await readFiscalYears(db, userId);
  if (settings.closedThrough === null) return;
  if (known.some((d) => stretchOf(settings, d) === "closed")) {
    throw new HttpsError("failed-precondition", closedRefusal(settings, what));
  }
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

export interface FiscalYearsChange {
  startMonth?: unknown;
  trackedFrom?: unknown;
  closedThrough?: unknown;
}

function invalid(message: string): never {
  throw new HttpsError("invalid-argument", message);
}

function parseChange(change: FiscalYearsChange, current: FiscalYearSettings): FiscalYearSettings {
  const next = { ...current };
  if (change.startMonth !== undefined) {
    const value = change.startMonth;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) {
      invalid("startMonth must be a whole number from 1 (January) to 12 (December)");
    }
    next.startMonth = value;
  }
  if (change.trackedFrom !== undefined) {
    if (!isMonth(change.trackedFrom)) invalid("trackedFrom must be a month, YYYY-MM");
    next.trackedFrom = change.trackedFrom;
  }
  if (change.closedThrough !== undefined) {
    if (change.closedThrough !== null && !isMonth(change.closedThrough)) {
      invalid("closedThrough must be a month, YYYY-MM, or null for none");
    }
    next.closedThrough = change.closedThrough;
  }
  return next;
}

/** The order untracked, closed, open: Tracked From on or before the month after Closed Through. */
function assertOrder(next: FiscalYearSettings, change: FiscalYearsChange): void {
  if (next.closedThrough === null) return;
  const monthAfterClosed = addMonths(next.closedThrough, 1);
  if (next.trackedFrom <= monthAfterClosed) return;
  const message =
    change.trackedFrom !== undefined
      ? `Tracked From ${next.trackedFrom} would leave a gap after Closed Through ${next.closedThrough}; ` +
        `it can be ${monthAfterClosed} at the latest. Move Closed Through first.`
      : `Closed Through ${next.closedThrough} lies before Tracked From ${next.trackedFrom}; ` +
        `it can be ${addMonths(next.trackedFrom, -1)} at the earliest.`;
  throw new HttpsError("failed-precondition", message);
}

/** The first stored Transaction or File dated in [from, to), as its month, or null. */
async function firstDataBetween(db: Db, userId: string, from: Month, to: Month): Promise<Month | null> {
  const start = Timestamp.fromDate(new Date(`${from}-01T00:00:00Z`));
  const end = Timestamp.fromDate(new Date(`${to}-01T00:00:00Z`));
  const months: Month[] = [];
  for (const [collection, field] of [
    ["transactions", "date"],
    ["files", "extractedDate"],
  ] as const) {
    const snap = await db
      .collection(collection)
      .where("userId", "==", userId)
      .where(field, ">=", start)
      .where(field, "<", end)
      .orderBy(field, "asc")
      .limit(1)
      .get();
    const date = snap.empty ? null : toDateSafe(snap.docs[0].data()[field]);
    if (date) months.push(monthOf(date));
  }
  return months.length > 0 ? months.sort()[0] : null;
}

const SAME = (a: FiscalYearSettings, b: FiscalYearSettings) =>
  a.startMonth === b.startMonth && a.trackedFrom === b.trackedFrom && a.closedThrough === b.closedThrough;

/**
 * Change any of the three. Refuses a change that breaks the order, and moving
 * Tracked From later over months that hold data. Writes the settings and one
 * append-only record, and returns that record; a change that changes nothing
 * writes nothing and returns none.
 */
export async function changeFiscalYears(
  db: Db,
  userId: string,
  change: FiscalYearsChange,
  via: FiscalYearsVia
): Promise<{ settings: FiscalYearSettings; record: FiscalYearChangeRecord | null }> {
  if (!change || typeof change !== "object") invalid("Pass startMonth, trackedFrom or closedThrough");
  const previous = await readFiscalYears(db, userId);
  const next = parseChange(change, previous);
  if (SAME(previous, next)) return { settings: previous, record: null };

  assertOrder(next, change);
  if (next.trackedFrom > previous.trackedFrom) {
    const held = await firstDataBetween(db, userId, previous.trackedFrom, next.trackedFrom);
    if (held) {
      throw new HttpsError(
        "failed-precondition",
        `Tracked From cannot move to ${next.trackedFrom}: ${held} holds Transactions or Files, ` +
          "and FiBuKI never hides what is stored. Close those months instead (Closed Through)."
      );
    }
  }

  const changedAt = Timestamp.now();
  const recordRef = db.collection(FISCAL_YEAR_CHANGES).doc();
  const batch = db.batch();
  batch.set(settingsRef(db, userId), { ...next, updatedAt: FieldValue.serverTimestamp() });
  batch.set(recordRef, { userId, changedBy: userId, changedAt, via, previous, next });
  await batch.commit();

  return {
    settings: next,
    record: {
      id: recordRef.id,
      changedBy: userId,
      changedAt: changedAt.toDate().toISOString(),
      via,
      previous,
      next,
    },
  };
}

/** The User's change records, newest first. */
export async function listFiscalYearChanges(db: Db, userId: string, limit = 20): Promise<FiscalYearChangeRecord[]> {
  const snap = await db.collection(FISCAL_YEAR_CHANGES).where("userId", "==", userId).get();
  return snap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        changedBy: data.changedBy,
        changedAt: toDateSafe(data.changedAt)?.toISOString() ?? "",
        via: data.via,
        previous: data.previous,
        next: data.next,
      } as FiscalYearChangeRecord;
    })
    .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
    .slice(0, limit);
}
