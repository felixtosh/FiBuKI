/**
 * #640: a dry-run report of the Files whose hand-corrected direction an
 * earlier identity sweep may have changed, for the User to re-check.
 *
 * Until #640 the identity sweep overwrote a direction the User had set by
 * hand whenever its derivation disagreed. The User's value is not stored
 * anywhere, so nothing can be repaired automatically, and nothing here writes.
 *
 * The evidence is the sweeps' run reports (`users/{uid}/directionSweeps`,
 * #158) read against each File's Hand Correction record:
 *
 * - The File's record names `invoiceDirection`, stamped when the User last set
 *   it.
 * - A run of the same User's sweep finished after that stamp, wrote at least
 *   one File, and is not marked `keepsHandCorrectedDirections` (every run
 *   since #640 is, and kept every hand-corrected direction).
 *
 * A run report counts the Files it wrote but never named them, so this cannot
 * tell whether that run wrote this File. The list is therefore every File
 * such a run could have flipped: a File whose correction agreed with the
 * derivation is on it too, and re-checking it finds nothing to fix. Runs from
 * before #158 left no report at all, so a flip by one of them cannot be seen;
 * the report gives the earliest run it read.
 *
 * Files marked Not Invoice are left out: a sweep skips them, and they carry
 * no direction to re-check.
 */

import { getFirestore } from "firebase-admin/firestore";
import { toDateSafe } from "../utils/toDateSafe";

export interface SweptDirectionRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** How many Files the run wrote, of all the User's Files. */
  written: number;
}

export interface SweptDirectionCandidate {
  fileId: string;
  userId: string;
  fileName: string | null;
  /** The direction the File holds now. */
  direction: string | null;
  /** When the User last set the direction by hand. */
  directionCorrectedAt: string;
  /** The File is soft-deleted. Listed so the count adds up; re-checking it can wait. */
  deleted: boolean;
  /** The runs that finished after the correction and could have flipped it. */
  runs: SweptDirectionRun[];
}

export interface SweptDirectionsReport {
  /** Run reports read, of every kind. */
  runsRead: number;
  /** Of those, the runs that wrote Files without keeping hand-corrected directions. */
  runsThatCouldFlip: number;
  /** The earliest run report read: a flip before it left no trace. */
  earliestRunAt: string | null;
  /** Files whose Hand Correction record names the direction. */
  handCorrectedDirections: number;
  candidates: SweptDirectionCandidate[];
}

export interface ReportSweptDirectionsOptions {
  /** Only this User's Files and runs. */
  userId?: string;
  log?: (line: string) => void;
}

export async function reportSweptHandCorrectedDirections(
  opts: ReportSweptDirectionsOptions = {}
): Promise<SweptDirectionsReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const db = getFirestore();

  const runSnap = opts.userId
    ? await db.collection(`users/${opts.userId}/directionSweeps`).get()
    : await db.collectionGroup("directionSweeps").get();

  let earliestRunAt: string | null = null;
  const flippingRunsByUser = new Map<string, SweptDirectionRun[]>();
  for (const doc of runSnap.docs) {
    const run = doc.data() as Record<string, unknown>;
    const startedAt = typeof run.startedAt === "string" ? run.startedAt : null;
    const finishedAt = typeof run.finishedAt === "string" ? run.finishedAt : startedAt;
    if (startedAt && (earliestRunAt === null || startedAt < earliestRunAt)) earliestRunAt = startedAt;

    const written = Number((run.outcomes as Record<string, unknown> | undefined)?.written ?? 0);
    if (run.keepsHandCorrectedDirections === true || !(written > 0) || !finishedAt) continue;

    const userId = String(run.userId ?? "");
    const runs = flippingRunsByUser.get(userId) ?? [];
    runs.push({ runId: String(run.runId ?? doc.id), startedAt: startedAt ?? finishedAt, finishedAt, written });
    flippingRunsByUser.set(userId, runs);
  }

  let filesQuery = db.collection("files").where("extractionCorrectedAt", "!=", null);
  if (opts.userId) filesQuery = filesQuery.where("userId", "==", opts.userId);
  const fileSnap = await filesQuery.get();

  let handCorrectedDirections = 0;
  const candidates: SweptDirectionCandidate[] = [];
  for (const doc of fileSnap.docs) {
    const file = doc.data() as Record<string, unknown>;
    const stamps = file.extractionCorrectedFields as Record<string, unknown> | null | undefined;
    const correctedAt = toDateSafe(stamps?.invoiceDirection);
    if (!correctedAt) continue;
    handCorrectedDirections++;
    if (file.isNotInvoice === true) continue;

    const userId = String(file.userId ?? "");
    const correctedIso = correctedAt.toISOString();
    const runs = (flippingRunsByUser.get(userId) ?? [])
      .filter((run) => run.finishedAt > correctedIso)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (runs.length === 0) continue;

    candidates.push({
      fileId: doc.id,
      userId,
      fileName: typeof file.fileName === "string" ? file.fileName : null,
      direction: typeof file.invoiceDirection === "string" ? file.invoiceDirection : null,
      directionCorrectedAt: correctedIso,
      deleted: file.deletedAt !== null && file.deletedAt !== undefined,
      runs,
    });
  }

  candidates.sort((a, b) => a.userId.localeCompare(b.userId) || a.fileId.localeCompare(b.fileId));

  for (const c of candidates) {
    log(
      `  ${c.fileId} (user ${c.userId}) "${c.fileName ?? ""}": direction now ${c.direction ?? "none"}, ` +
        `set by hand ${c.directionCorrectedAt.slice(0, 10)}, ` +
        `${c.runs.length} sweep run(s) after it, first ${c.runs[0].startedAt.slice(0, 10)}` +
        (c.deleted ? " (deleted)" : "")
    );
  }

  return {
    runsRead: runSnap.size,
    runsThatCouldFlip: [...flippingRunsByUser.values()].reduce((sum, runs) => sum + runs.length, 0),
    earliestRunAt,
    handCorrectedDirections,
    candidates,
  };
}
