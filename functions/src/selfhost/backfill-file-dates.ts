/**
 * #641: store every File's Due Date and Debit Date as the File facts module
 * derives them, once, so the scorer reads stored dates only.
 *
 * Until #641 the scorer read a File that stored neither date off its
 * additional-fields rows on the fly, without the issue-date guard (#135), and
 * a date stored before the guard or before a correction of the issue date
 * stayed as it was. This runs every File through the module
 * (`decideFactChange`, origin `date-backfill`) and writes what it returns
 * through the one applier, so the write and its follow-up (a suggestions-only
 * re-score of a File whose date moved) are the module's.
 *
 * Skipped, and counted:
 * - a File whose Hand Correction record names the Due Date or the Debit Date:
 *   the User set it (the module refuses it);
 * - a File in its Extraction pipeline (`extractionComplete === false`): the
 *   Extraction stores both dates itself when it finishes.
 *
 * Dry run unless `apply`. An applied run names its scope: one user
 * (`userId`) or, explicitly, every user (`allUsers`): fibuki.com is one
 * tenant with many users, so an applied run never writes other people's Files
 * by default. Idempotent: a File that already stores what the module derives
 * is not written, so a second run writes nothing, and a run that stopped
 * part-way is finished by running it again. Postgres only, never wired into
 * index.ts.
 */

import type { Firestore, Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { decideFactChange } from "../fileFacts/factChange";
import { applyFactChange } from "../fileFacts/applyFactChange";
import { dueDateFromAdditionalFields } from "../matching/dueDate";
import { debitDateFromAdditionalFields } from "../matching/debitDate";
import { toDateSafe } from "../utils/toDateSafe";

type FileData = Record<string, unknown>;
type DateField = "dueDate" | "debitDate";

const STORED: Record<DateField, "extractedDueDate" | "extractedDebitDate"> = {
  dueDate: "extractedDueDate",
  debitDate: "extractedDebitDate",
};

/** The rows reader each date had on the fly until #641 (without the issue-date guard). */
const ON_THE_FLY: Record<DateField, (rows: unknown) => Date | null> = {
  dueDate: (rows) => dueDateFromAdditionalFields(rows),
  debitDate: (rows) => debitDateFromAdditionalFields(rows),
};

/** One date's move, as calendar days (YYYY-MM-DD); null is no date. */
export interface DateMove {
  from: string | null;
  to: string | null;
}

export interface FileDatesChange {
  fileId: string;
  userId: string;
  fileName: string | null;
  dueDate?: DateMove;
  debitDate?: DateMove;
}

export interface DateCounts {
  /** Stored no date, stores one. */
  gained: number;
  /** Stored one date, stores another. */
  changed: number;
  /** Stored a date, stores none. */
  lost: number;
}

export interface FileDatesBackfillReport {
  /** Whose Files the run covered: one user's, or every user's on the deployment. */
  scope: { kind: "user"; userId: string } | { kind: "allUsers" };
  applied: boolean;
  filesScanned: number;
  /** Files whose stored dates move: written with `apply`, else would be. */
  filesChanged: number;
  dueDate: DateCounts;
  debitDate: DateCounts;
  /**
   * Files whose Due Date (or Debit Date) as the scorer read it until #641 lay
   * before the issue day, and after the run does not (#135). "As the scorer
   * read it": the stored date, or, on a record that stored none, the date the
   * scorer read off the rows on the fly. Such a record may need no write: the
   * scorer simply stops reading the rows.
   */
  inversionsFixed: { dueDate: number; debitDate: number };
  /**
   * Files the scorer gave a date on the fly until #641: they do not store the
   * date field, and their rows state one. Between the deploy and this run
   * they score without it.
   */
  scoredOnTheFly: number;
  /** Files left alone because the User set the Due Date or Debit Date by hand. */
  skippedHandCorrected: Array<{ fileId: string; userId: string; fields: string[] }>;
  /** Files in their Extraction pipeline, which stores both dates when it finishes. */
  skippedInPipeline: string[];
  /** Files the applier refused at write time (gone, or hand-corrected in the meantime). */
  refused: Array<{ fileId: string; reason: string }>;
  failed: Array<{ fileId: string; error: string }>;
  /** Each user with changed Files, and how many. */
  users: Array<{ userId: string; changed: number }>;
  changes: FileDatesChange[];
}

export interface FileDatesBackfillOptions {
  apply?: boolean;
  /** Only this user's Files. An applied run needs this or `allUsers`. */
  userId?: string;
  /** Every user's Files. An applied run must say so. Excludes `userId`. */
  allUsers?: boolean;
  /** Files read per page (default 200). Only one page is held at a time. */
  pageSize?: number;
  /** Called with the planned changes before the first write. */
  beforeWrite?: (planned: FileDatesBackfillReport) => Promise<void>;
  /** The time stamped on each write (default now). */
  at?: Timestamp;
  log?: (line: string) => void;
}

/** A stored date names the UTC midnight of its day: read the UTC date part. */
function isoDay(value: unknown): string | null {
  const date = toDateSafe(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/** What one date does under the module's update, against the record as read. */
function moveOf(record: FileData, update: FileData, field: DateField): DateMove | undefined {
  const stored = STORED[field];
  if (!(stored in update)) return undefined;
  return { from: isoDay(record[stored]), to: isoDay(update[stored]) };
}

function movesOf(record: FileData, update: FileData): Pick<FileDatesChange, DateField> {
  const moves: Pick<FileDatesChange, DateField> = {};
  for (const field of FIELDS) {
    const move = moveOf(record, update, field);
    if (move) moves[field] = move;
  }
  return moves;
}

function count(counts: DateCounts, move: DateMove | undefined): void {
  if (!move) return;
  if (move.from === null && move.to !== null) counts.gained++;
  else if (move.from !== null && move.to === null) counts.lost++;
  else if (move.from !== move.to) counts.changed++;
}

/** The date the scorer read until #641: the stored one, or the rows' on a record that stored none. */
function scoredBefore(record: FileData, field: DateField): string | null {
  const stored = STORED[field];
  if (stored in record) return isoDay(record[stored]);
  return isoDay(ON_THE_FLY[field](record.extractedAdditionalFields));
}

function invertedBefore(record: FileData, field: DateField): boolean {
  const issue = isoDay(record.extractedDate);
  const before = scoredBefore(record, field);
  return issue !== null && before !== null && before < issue;
}

/** A date the record does not store, which the scorer read off its rows until #641. */
function readOnTheFly(record: FileData, field: DateField): boolean {
  return !(STORED[field] in record) && ON_THE_FLY[field](record.extractedAdditionalFields) !== null;
}

const FIELDS: readonly DateField[] = ["dueDate", "debitDate"];

export async function backfillFileDates(
  opts: FileDatesBackfillOptions = {}
): Promise<FileDatesBackfillReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (opts.userId && opts.allUsers) {
    throw new Error("userId and allUsers exclude each other: name one user, or every user");
  }
  if (opts.apply && !opts.userId && !opts.allUsers) {
    throw new Error(
      "an applied run needs a scope: userId for one user's Files, or allUsers for every user's " +
        "(it writes other people's Files on a shared deployment)"
    );
  }
  const db: Firestore = getFirestore();
  const at = opts.at ?? Timestamp.now();

  const report: FileDatesBackfillReport = {
    scope: opts.userId ? { kind: "user", userId: opts.userId } : { kind: "allUsers" },
    applied: !!opts.apply,
    filesScanned: 0,
    filesChanged: 0,
    dueDate: { gained: 0, changed: 0, lost: 0 },
    debitDate: { gained: 0, changed: 0, lost: 0 },
    inversionsFixed: { dueDate: 0, debitDate: 0 },
    scoredOnTheFly: 0,
    skippedHandCorrected: [],
    skippedInPipeline: [],
    refused: [],
    failed: [],
    users: [],
    changes: [],
  };

  // Paged by document id, so only one page of Files is held at a time; a
  // changed File keeps only its summary. The module decides on the record as
  // read; the applier decides again on the File as it is when written.
  const pageSize = opts.pageSize ?? 200;
  const base: Query = opts.userId
    ? db.collection("files").where("userId", "==", opts.userId)
    : db.collection("files");
  // Which dates of a changed File the run un-inverts, so a File the applier
  // then refuses is taken off the count again.
  const inversionsOf = new Map<string, DateField[]>();
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let page = base.orderBy("__name__").limit(pageSize);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    for (const doc of snap.docs) plan(doc.id, (doc.data() ?? {}) as FileData);
    report.filesScanned += snap.size;
    if (snap.size < pageSize) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  function plan(fileId: string, record: FileData): void {
    if (record.extractionComplete === false) {
      report.skippedInPipeline.push(fileId);
      return;
    }
    const userId = String(record.userId ?? "");
    const outcome = decideFactChange(
      { record, linkedTransactions: [] },
      { origin: "date-backfill", at }
    );
    if (outcome.refused) {
      report.skippedHandCorrected.push({ fileId, userId, fields: outcome.fields ?? [] });
      return;
    }
    if (FIELDS.some((field) => readOnTheFly(record, field))) report.scoredOnTheFly++;
    // The module's dates never lie before the issue day, so an inversion the
    // scorer read is fixed by the run, written or not.
    const inverted = FIELDS.filter((field) => invertedBefore(record, field));
    for (const field of inverted) report.inversionsFixed[field]++;
    if (Object.keys(outcome.update).length === 0) return;
    inversionsOf.set(fileId, inverted);
    report.changes.push({
      fileId,
      userId,
      fileName: typeof record.fileName === "string" ? record.fileName : null,
      ...movesOf(record, outcome.update),
    });
  }

  /** The File was not written after all: its inversions stay as they were. */
  function unfixed(fileId: string): void {
    for (const field of inversionsOf.get(fileId) ?? []) report.inversionsFixed[field]--;
  }

  if (opts.apply && report.changes.length > 0) {
    tally(report);
    if (opts.beforeWrite) await opts.beforeWrite(structuredClone(report));

    const planned = report.changes;
    report.changes = [];
    for (const change of planned) {
      try {
        const applied = await applyFactChange(db, {
          fileId: change.fileId,
          userId: change.userId,
          change: { origin: "date-backfill", at },
        });
        if (applied.refused) {
          unfixed(change.fileId);
          if (applied.code === "HAND_CORRECTED") {
            report.skippedHandCorrected.push({
              fileId: change.fileId,
              userId: change.userId,
              fields: applied.fields ?? [],
            });
          } else {
            report.refused.push({ fileId: change.fileId, reason: `${applied.code}: ${applied.message}` });
          }
          continue;
        }
        if (Object.keys(applied.update).length === 0) continue;
        report.changes.push({
          fileId: change.fileId,
          userId: change.userId,
          fileName: change.fileName,
          ...movesOf(applied.before, applied.update),
        });
      } catch (error) {
        unfixed(change.fileId);
        report.failed.push({
          fileId: change.fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  tally(report);
  log(
    `  ${report.filesChanged} of ${report.filesScanned} File(s) ${report.applied ? "written" : "would change"}; ` +
      `Due Date ${describe(report.dueDate)}, Debit Date ${describe(report.debitDate)}; ` +
      `inversions fixed: ${report.inversionsFixed.dueDate} Due Date, ${report.inversionsFixed.debitDate} Debit Date; ` +
      `${report.skippedHandCorrected.length} skipped as hand-corrected, ` +
      `${report.skippedInPipeline.length} in their Extraction pipeline` +
      (report.applied ? `, ${report.refused.length} refused, ${report.failed.length} failed` : " (dry run, nothing written)")
  );
  return report;
}

/** Recount the figures from the change list, so a dry run and an applied run count the same way. */
function tally(report: FileDatesBackfillReport): void {
  report.dueDate = { gained: 0, changed: 0, lost: 0 };
  report.debitDate = { gained: 0, changed: 0, lost: 0 };
  const perUser = new Map<string, number>();
  for (const change of report.changes) {
    count(report.dueDate, change.dueDate);
    count(report.debitDate, change.debitDate);
    perUser.set(change.userId, (perUser.get(change.userId) ?? 0) + 1);
  }
  report.filesChanged = report.changes.length;
  report.users = [...perUser].map(([userId, changed]) => ({ userId, changed }));
}

function describe(counts: DateCounts): string {
  return `+${counts.gained} gained, ~${counts.changed} changed, -${counts.lost} lost`;
}
