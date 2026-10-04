/**
 * #619: re-read the Debit Date on Files whose SEPA collection sentence became
 * a Due Date only.
 *
 * Files extracted before the field vocabulary stored the date of "Der Betrag
 * wird (frühestens) am ... per SEPA-Mandat eingezogen" as a keyless
 * "Zahlungstermin" row: a Due Date, without the Debit Date's settlement lag
 * and near-proof. The current prompt files that sentence under `debitDate`,
 * so a fresh Extraction repairs them. No stored field can be rewritten
 * instead: the row's label says "Zahlungstermin", and only the document says
 * it was a collection.
 *
 * A candidate is a live File, extracted without error and not ruled "not an
 * invoice", whose extracted text mentions a SEPA mandate, "eingezogen" or
 * "Lastschrift", and which has no Debit Date (neither the typed field nor a
 * row the Debit Date reader accepts).
 *
 * Each candidate goes through the same Retry as the UI's button
 * (retryExtractionForFile, force), so its eligibility check, hand-correction
 * refusal and reset apply unchanged: a hand-corrected File is skipped and
 * counted, never overwritten. The Extractions run on the extraction worker;
 * an applied run waits for them and reports which Files gained a Debit Date.
 *
 * Dry run unless `apply` is set. An applied run names its scope: one user
 * (`userId`) or, explicitly, every user (`allUsers`). fibuki.com is one tenant
 * with many users, and a re-extraction spends its owner's AI usage, so an
 * applied run never reaches every user by default. A dry run may list every
 * user's candidates, and the report says whose Files it covered.
 * Postgres only, never wired into index.ts.
 */

import type { Firestore } from "firebase-admin/firestore";
import { getFirestore } from "firebase-admin/firestore";
import { debitDateFromAdditionalFields } from "../matching/debitDate";
import { dueDateFromAdditionalFields } from "../matching/dueDate";
import { toDateSafe } from "../utils/toDateSafe";
import { correctedFieldsOf } from "../files/extractionProvenanceOps";
import { RetryExtractionError, retryExtractionForFile } from "../extraction/retryExtractionOps";

/**
 * A SEPA mandate, a collection ("eingezogen") or a direct debit
 * ("Lastschrift", which also covers "Lastschriftmandat"). Bounded, so a long
 * text cannot make it backtrack far.
 */
const SEPA_COLLECTION_TEXT = /SEPA[^\n]{0,30}?mandat|eingezogen|lastschrift/i;

export interface SepaDebitDateCandidate {
  fileId: string;
  userId: string;
  fileName: string | null;
  /** The phrase in the extracted text that made it a candidate. */
  matched: string;
  /** The Due Date it carries today (YYYY-MM-DD), or null. */
  dueDate: string | null;
  /** Fields a person corrected by hand; non-empty means the run skips it. */
  handCorrected: string[];
}

export interface SepaDebitDateReport {
  /** Whose Files the run covered: one user's, or every user's on the deployment. */
  scope: { kind: "user"; userId: string } | { kind: "allUsers" };
  /** Each user with candidates, and how many. */
  users: Array<{ userId: string; candidates: number }>;
  filesScanned: number;
  candidates: SepaDebitDateCandidate[];
  /** Candidates queued for a fresh Extraction (applied run only). */
  queued: string[];
  /** Candidates left alone because a person corrected them by hand. */
  skippedHandCorrected: string[];
  /** Candidates the Retry refused for another reason. */
  refused: Array<{ fileId: string; reason: string }>;
  /** Re-extracted Files that now carry a Debit Date. */
  gainedDebitDate: Array<{ fileId: string; debitDate: string }>;
  /** Re-extracted Files that still carry none. */
  noDebitDate: string[];
  /** Re-extractions that failed. */
  failed: Array<{ fileId: string; error: string }>;
  /** Queued Files whose Extraction had not finished when the wait ran out. */
  stillRunning: string[];
  applied: boolean;
}

export interface SepaDebitDateOptions {
  apply?: boolean;
  /** Only this user's Files. An applied run needs this or `allUsers`. */
  userId?: string;
  /**
   * Every user's Files. An applied run must say so: it re-extracts other
   * people's Files on their AI usage. Excludes `userId`.
   */
  allUsers?: boolean;
  /** How long an applied run waits for the Extractions (default 60 minutes). */
  timeoutMs?: number;
  /** How often it looks (default 5 seconds). */
  pollMs?: number;
  /**
   * Runs the queue in this process before each look. The tests pass the
   * worker's drain; on a deployment the fibuki-api worker runs the jobs.
   */
  drain?: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

type FileData = Record<string, unknown>;

/** A stored date is UTC midnight of the Vienna day: read the UTC date part. */
function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** The File's Debit Date as the scorer reads it: the typed field, else a row. */
function debitDateOf(data: FileData): Date | null {
  const typed = toDateSafe(data.extractedDebitDate);
  if (typed) return typed;
  return debitDateFromAdditionalFields(data.extractedAdditionalFields, toDateSafe(data.extractedDate));
}

/** The phrase that makes this File a candidate, or null when it is none. */
export function sepaCandidatePhrase(data: FileData): string | null {
  if (data.deletedAt || data.purgedAt) return null;
  if (data.extractionComplete !== true || data.extractionError) return null;
  if (data.isNotInvoice === true) return null;
  if (typeof data.extractedText !== "string") return null;
  const match = SEPA_COLLECTION_TEXT.exec(data.extractedText);
  if (!match) return null;
  if (debitDateOf(data)) return null;
  return match[0];
}

async function waitForExtractions(
  db: Firestore,
  fileIds: string[],
  opts: Required<Pick<SepaDebitDateOptions, "timeoutMs" | "pollMs" | "sleep" | "log">> &
    Pick<SepaDebitDateOptions, "drain">,
  report: SepaDebitDateReport,
): Promise<void> {
  const pending = new Set(fileIds);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (opts.drain) await opts.drain();
    for (const fileId of [...pending]) {
      const data = (await db.collection("files").doc(fileId).get()).data() as FileData | undefined;
      if (!data) {
        report.failed.push({ fileId, error: "File disappeared during the run" });
        pending.delete(fileId);
        continue;
      }
      if (data.extractionError) {
        report.failed.push({ fileId, error: String(data.extractionError) });
      } else if (data.extractionComplete === true) {
        const debit = debitDateOf(data);
        if (debit) report.gainedDebitDate.push({ fileId, debitDate: isoDay(debit)! });
        else report.noDebitDate.push(fileId);
      } else {
        continue;
      }
      pending.delete(fileId);
    }
    if (pending.size === 0) return;
    if (Date.now() >= deadline) {
      report.stillRunning.push(...pending);
      return;
    }
    opts.log(`  waiting for ${pending.size} Extraction(s)`);
    await opts.sleep(opts.pollMs);
  }
}

export async function migrateSepaDebitDate(
  opts: SepaDebitDateOptions = {},
): Promise<SepaDebitDateReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.userId && opts.allUsers) {
    throw new Error("userId and allUsers exclude each other: name one user, or every user");
  }
  if (opts.apply && !opts.userId && !opts.allUsers) {
    throw new Error(
      "an applied run needs a scope: userId for one user's Files, or allUsers for every user's " +
        "(re-extraction spends each File owner's AI usage)",
    );
  }
  const db = getFirestore();

  const files = opts.userId
    ? await db.collection("files").where("userId", "==", opts.userId).get()
    : await db.collection("files").get();

  const report: SepaDebitDateReport = {
    scope: opts.userId ? { kind: "user", userId: opts.userId } : { kind: "allUsers" },
    users: [],
    filesScanned: files.size,
    candidates: [],
    queued: [],
    skippedHandCorrected: [],
    refused: [],
    gainedDebitDate: [],
    noDebitDate: [],
    failed: [],
    stillRunning: [],
    applied: !!opts.apply,
  };

  for (const doc of files.docs) {
    const data = (doc.data() ?? {}) as FileData;
    const matched = sepaCandidatePhrase(data);
    if (!matched) continue;
    report.candidates.push({
      fileId: doc.id,
      userId: String(data.userId),
      fileName: typeof data.fileName === "string" ? data.fileName : null,
      matched,
      dueDate: isoDay(
        toDateSafe(data.extractedDueDate) ??
          dueDateFromAdditionalFields(data.extractedAdditionalFields, toDateSafe(data.extractedDate)),
      ),
      handCorrected: correctedFieldsOf(data),
    });
  }

  const perUser = new Map<string, number>();
  for (const c of report.candidates) perUser.set(c.userId, (perUser.get(c.userId) ?? 0) + 1);
  report.users = [...perUser].map(([userId, candidates]) => ({ userId, candidates }));
  log(
    report.scope.kind === "user"
      ? `  covers user ${report.scope.userId} only`
      : `  covers every user on the deployment; ${report.users.length} with candidates` +
          (report.users.length > 0
            ? `: ${report.users.map((u) => `${u.userId} (${u.candidates})`).join(", ")}`
            : ""),
  );

  for (const c of report.candidates) {
    log(
      `  ${c.fileId}  ${c.userId}  ${c.fileName ?? "(no name)"}  "${c.matched}"  due ${c.dueDate ?? "-"}` +
        (c.handCorrected.length > 0 ? `  hand-corrected (${c.handCorrected.join(", ")}), skipped` : ""),
    );
  }

  if (!opts.apply) {
    const skipped = report.candidates.filter((c) => c.handCorrected.length > 0).length;
    log(
      `  ${report.candidates.length} candidate(s) of ${files.size} File(s) scanned, ` +
        `${skipped} of them hand-corrected and skipped (dry run, nothing queued)`,
    );
    return report;
  }

  for (const c of report.candidates) {
    try {
      // The candidate's owner is the Retry's caller: the run acts for each
      // owner the way the admin bulk retry does.
      await retryExtractionForFile(db, { fileId: c.fileId, userId: c.userId, force: true });
      report.queued.push(c.fileId);
    } catch (error) {
      if (error instanceof RetryExtractionError && error.code === "HAND_CORRECTED") {
        report.skippedHandCorrected.push(c.fileId);
      } else if (error instanceof RetryExtractionError) {
        report.refused.push({ fileId: c.fileId, reason: `${error.code}: ${error.message}` });
      } else {
        throw error;
      }
    }
  }
  log(`  queued ${report.queued.length}, skipped ${report.skippedHandCorrected.length} as hand-corrected`);

  await waitForExtractions(
    db,
    report.queued,
    {
      timeoutMs: opts.timeoutMs ?? 60 * 60 * 1000,
      pollMs: opts.pollMs ?? 5000,
      sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      log,
      drain: opts.drain,
    },
    report,
  );

  log(
    `  ${report.gainedDebitDate.length} gained a Debit Date, ${report.noDebitDate.length} still have none, ` +
      `${report.skippedHandCorrected.length} skipped as hand-corrected, ${report.failed.length} failed, ` +
      `${report.refused.length} refused, ${report.stillRunning.length} still running`,
  );
  return report;
}
