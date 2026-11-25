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
 * reads it, ADR-0016). The first read stores the default, so it never moves
 * with the clock. Every change, the stored default included, appends one
 * record to users/{uid}/fiscalYearChanges, which nothing ever updates.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";
import {
  addMonths,
  changesRef,
  currentMonth,
  firstDataMonth,
  isMonth,
  parseStored,
  readFiscalYears,
  settingsRef,
  stretchOf,
  type FiscalYearChangeRecord,
  type FiscalYearSettings,
  type FiscalYearsVia,
  type Month,
} from "./settings";

export * from "./settings";

type Db = FirebaseFirestore.Firestore;

/** Why a change was refused, for a screen to say it in the User's language. */
export type FiscalYearsRefusal =
  | "invalid"
  | "after-current-month"
  | "closed-before-tracked"
  | "tracked-after-gap"
  | "tracked-from-holds-data";

/** What a refusal says: Closed Through, and how to lift it. */
export function closedRefusal(settings: FiscalYearSettings, what: string): string {
  return (
    `${what} is dated in a closed month: Closed Through is ${settings.closedThrough}. ` +
    "To change it, move Closed Through back before that month (Settings, Fiscal Years, or the set_fiscal_years tool), " +
    "make the change, then move it forward again."
  );
}

/** What a refusal says when a write would land before Tracked From. */
export function untrackedRefusal(settings: FiscalYearSettings, what: string): string {
  return (
    `${what} would be dated before Tracked From ${settings.trackedFrom}, a month FiBuKI does not track. ` +
    "Move Tracked From back first (Settings, Fiscal Years, or the set_fiscal_years tool)."
  );
}

/** The User's settings once, and the checks against them, for a caller with many rows. */
export async function fiscalYearsGuard(db: Db, userId: string) {
  const settings = await readFiscalYears(db, userId);
  const known = (dates: Array<Date | null | undefined>) =>
    dates.filter((d): d is Date => d instanceof Date && !isNaN(d.getTime()));
  return {
    settings,
    /** Refuse when any of these dates lies in the Closed stretch. */
    refuseClosed(dates: Array<Date | null | undefined>, what: string): void {
      if (settings.closedThrough === null) return;
      if (known(dates).some((d) => stretchOf(settings, d) === "closed")) {
        throw new HttpsError("failed-precondition", closedRefusal(settings, what));
      }
    },
    /** Refuse when any of these dates lies before Tracked From. */
    refuseUntracked(dates: Array<Date | null | undefined>, what: string): void {
      if (known(dates).some((d) => stretchOf(settings, d) === "untracked")) {
        throw new HttpsError("failed-precondition", untrackedRefusal(settings, what));
      }
    },
  };
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
  if (!dates.some((d) => d instanceof Date && !isNaN(d.getTime()))) return;
  (await fiscalYearsGuard(db, userId)).refuseClosed(dates, what);
}

/** Refuse when any of these dates lies before Tracked From, naming it. */
export async function assertTracked(
  db: Db,
  userId: string,
  dates: Array<Date | null | undefined>,
  what: string
): Promise<void> {
  if (!dates.some((d) => d instanceof Date && !isNaN(d.getTime()))) return;
  (await fiscalYearsGuard(db, userId)).refuseUntracked(dates, what);
}

export interface FiscalYearsChange {
  startMonth?: unknown;
  trackedFrom?: unknown;
  closedThrough?: unknown;
}

function refuse(
  code: "invalid-argument" | "failed-precondition",
  reason: FiscalYearsRefusal,
  message: string,
  month?: Month
): never {
  throw new HttpsError(code, message, { reason, ...(month ? { month } : {}) });
}

function parseChange(change: FiscalYearsChange, current: FiscalYearSettings): FiscalYearSettings {
  const next = { ...current };
  if (change.startMonth !== undefined) {
    const value = change.startMonth;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) {
      refuse("invalid-argument", "invalid", "startMonth must be a whole number from 1 (January) to 12 (December)");
    }
    next.startMonth = value;
  }
  if (change.trackedFrom !== undefined) {
    if (!isMonth(change.trackedFrom)) refuse("invalid-argument", "invalid", "trackedFrom must be a month, YYYY-MM");
    next.trackedFrom = change.trackedFrom;
  }
  if (change.closedThrough !== undefined) {
    if (change.closedThrough !== null && !isMonth(change.closedThrough)) {
      refuse("invalid-argument", "invalid", "closedThrough must be a month, YYYY-MM, or null for none");
    }
    next.closedThrough = change.closedThrough;
  }
  return next;
}

/** Neither month may lie after the current one: nothing is tracked or closed ahead of time. */
function assertNotAhead(next: FiscalYearSettings, change: FiscalYearsChange): void {
  const now = currentMonth();
  if (change.trackedFrom !== undefined && next.trackedFrom > now) {
    refuse("failed-precondition", "after-current-month", `Tracked From ${next.trackedFrom} lies after the current month ${now}.`, now);
  }
  if (change.closedThrough !== undefined && next.closedThrough !== null && next.closedThrough > now) {
    refuse("failed-precondition", "after-current-month", `Closed Through ${next.closedThrough} lies after the current month ${now}.`, now);
  }
}

/** The order untracked, closed, open: Tracked From on or before the month after Closed Through. */
function assertOrder(next: FiscalYearSettings, change: FiscalYearsChange): void {
  if (next.closedThrough === null) return;
  const monthAfterClosed = addMonths(next.closedThrough, 1);
  if (next.trackedFrom <= monthAfterClosed) return;
  if (change.trackedFrom !== undefined) {
    refuse(
      "failed-precondition",
      "tracked-after-gap",
      `Tracked From ${next.trackedFrom} would leave a gap after Closed Through ${next.closedThrough}; ` +
        `it can be ${monthAfterClosed} at the latest. Move Closed Through first.`,
      monthAfterClosed
    );
  }
  const earliest = addMonths(next.trackedFrom, -1);
  refuse(
    "failed-precondition",
    "closed-before-tracked",
    `Closed Through ${next.closedThrough} lies before Tracked From ${next.trackedFrom}; it can be ${earliest} at the earliest.`,
    earliest
  );
}

const SAME = (a: FiscalYearSettings, b: FiscalYearSettings) =>
  a.startMonth === b.startMonth && a.trackedFrom === b.trackedFrom && a.closedThrough === b.closedThrough;

/**
 * Change any of the three. Refuses a change that breaks the order, a month
 * after the current one, and moving Tracked From later over months that hold
 * data. Reads, checks and writes in one transaction, so two changes at once
 * cannot both record the same "previous". Writes the settings and one
 * append-only record, and returns that record; a change that changes nothing
 * writes nothing and returns none.
 */
export async function changeFiscalYears(
  db: Db,
  userId: string,
  change: FiscalYearsChange,
  via: Exclude<FiscalYearsVia, "initial">
): Promise<{ settings: FiscalYearSettings; record: FiscalYearChangeRecord | null }> {
  if (!change || typeof change !== "object") {
    refuse("invalid-argument", "invalid", "Pass startMonth, trackedFrom or closedThrough");
  }
  await readFiscalYears(db, userId); // stores the default first, so it is the record's "previous"

  return db.runTransaction(async (tx) => {
    const previous = parseStored((await tx.get(settingsRef(db, userId))).data());
    if (!previous) throw new HttpsError("aborted", "Fiscal Years settings missing; try again");
    const next = parseChange(change, previous);
    if (SAME(previous, next)) return { settings: previous, record: null };

    assertNotAhead(next, change);
    assertOrder(next, change);
    if (next.trackedFrom > previous.trackedFrom) {
      const held = await firstDataMonth(db, userId, previous.trackedFrom, next.trackedFrom);
      if (held) {
        refuse(
          "failed-precondition",
          "tracked-from-holds-data",
          `Tracked From cannot move to ${next.trackedFrom}: ${held} holds Transactions or Files, ` +
            "and FiBuKI never hides what is stored. Close those months instead (Closed Through).",
          held
        );
      }
    }

    const changedAt = Timestamp.now();
    const recordRef = changesRef(db, userId).doc();
    tx.set(settingsRef(db, userId), { ...next, updatedAt: FieldValue.serverTimestamp() });
    tx.set(recordRef, { userId, changedBy: userId, changedAt, via, previous, next });

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
  });
}

/** The User's change records, newest first. */
export async function listFiscalYearChanges(db: Db, userId: string, limit = 20): Promise<FiscalYearChangeRecord[]> {
  const snap = await changesRef(db, userId).orderBy("changedAt", "desc").limit(limit).get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      changedBy: data.changedBy,
      changedAt: toDateSafe(data.changedAt)?.toISOString() ?? "",
      via: data.via,
      previous: data.previous ?? null,
      next: data.next,
    } as FiscalYearChangeRecord;
  });
}
