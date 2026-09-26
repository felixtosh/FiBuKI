/**
 * What the identity-change sweep did, per File and per run (#158).
 *
 * The sweep in `onUserDataUpdate` used to keep two integers — `updatedCount`
 * and `skippedCount` — and a `skip` was whatever fell through the write path,
 * including the ones nobody meant. A run in which one File's write was
 * rejected and every File after it was dropped reported the same shape as a
 * clean run: a number, no names, and a log line that rotates away. That is
 * how #158 stayed invisible long enough to be noticed by hand.
 *
 * So a skip here is a NAMED outcome, every candidate lands in exactly one
 * bucket, and the buckets are checked to add up. A run that cannot account
 * for every File it read is `complete: false` — which is the signal anything
 * derived from `invoiceDirection` reads to know whether its inputs are whole.
 *
 * This module owns only the bookkeeping, the way `recipientIdentity.ts` owns
 * only the verdict: the counting rules are then testable without Firestore
 * and cannot drift from what the trigger reports.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { InvoiceDirection } from "../utils/identity-matcher";

/**
 * Why a File ended the run the way it did. Exactly one per candidate.
 *
 * The three that mean "the derivation never ran" are listed first; they are
 * the *never evaluated* half of the distinction the `updatedAt` evidence in
 * #158 turns on. A File that WAS evaluated and came out `unknown` is
 * `written` or `already-correct`, and shows up under `byDirection.unknown` —
 * a different thing entirely, and not a gap.
 */
export type SweepOutcome =
  /** Extraction has not finished, so there is nothing to re-derive from. */
  | "extraction-incomplete"
  /** The user marked it as not an invoice; direction does not apply. */
  | "not-an-invoice"
  /** Extraction read neither an issuer nor a recipient — nothing to compare. */
  | "no-entities"
  /** Re-derived, differs from what is stored, and the write landed. */
  | "written"
  /** Re-derived, and every field already holds the derived value. */
  | "already-correct"
  /** Re-deriving threw. The File keeps whatever it had. */
  | "evaluation-failed"
  /** Re-derived and planned, but the store refused the write. */
  | "write-rejected";

/** The outcomes in which the derivation never ran. */
export const NEVER_EVALUATED: ReadonlySet<SweepOutcome> = new Set<SweepOutcome>([
  "extraction-incomplete",
  "not-an-invoice",
  "no-entities",
]);

/** The outcomes that mean the run did not do its job for that File. */
export const FAILED_OUTCOMES: ReadonlySet<SweepOutcome> = new Set<SweepOutcome>([
  "evaluation-failed",
  "write-rejected",
]);

/** A File the run could not finish, kept by name so it can be chased. */
export interface SweepFailure {
  fileId: string;
  outcome: "evaluation-failed" | "write-rejected";
  /** The error as the store or the derivation reported it. */
  message: string;
}

/**
 * How many named failures a summary carries. Counts stay complete past this;
 * only the list is cut, and `failuresTruncated` says so.
 */
export const MAX_NAMED_FAILURES = 50;

export interface InvoiceDirectionSweepSummary {
  runId: string;
  userId: string;
  startedAt: string;
  finishedAt: string;
  /** Files read: the candidate set this run is accountable for. */
  candidates: number;
  /** One bucket per outcome. These sum to `candidates` or the run is broken. */
  outcomes: Record<SweepOutcome, number>;
  /** Candidates whose derivation was attempted. */
  evaluated: number;
  /** Candidates skipped before any derivation ran. */
  neverEvaluated: number;
  /**
   * The direction the derivation produced, over evaluated Files only. An
   * `unknown` here was evaluated and left `unknown` — it is not a File the
   * run missed.
   */
  byDirection: Record<InvoiceDirection, number>;
  /** Files the run could not finish, by name. Cut at {@link MAX_NAMED_FAILURES}. */
  failures: SweepFailure[];
  failuresTruncated: boolean;
  /**
   * True only when every candidate is accounted for and nothing failed. A
   * consumer of `invoiceDirection` that sees `false` is looking at a corpus
   * whose last sweep did not finish.
   */
  complete: boolean;
  /** Set when the scan hit its ceiling, so the candidate set is itself partial. */
  scanCeilingReached: boolean;
}

export function emptyOutcomeCounts(): Record<SweepOutcome, number> {
  // Written as a full literal on purpose: adding an outcome then fails to
  // compile here rather than silently counting nothing.
  return {
    "extraction-incomplete": 0,
    "not-an-invoice": 0,
    "no-entities": 0,
    written: 0,
    "already-correct": 0,
    "evaluation-failed": 0,
    "write-rejected": 0,
  };
}

export function emptyDirectionCounts(): Record<InvoiceDirection, number> {
  return { incoming: 0, outgoing: 0, unknown: 0 };
}

/**
 * The run's books.
 *
 * Every File the scan reads is recorded exactly once, and `record` is the
 * only way in — so "the sweep forgot to count this branch" is a missing call,
 * not a wrong number, and {@link SweepLedger.summarise} catches it either way.
 */
export class SweepLedger {
  readonly outcomes = emptyOutcomeCounts();
  readonly byDirection = emptyDirectionCounts();
  private readonly failures: SweepFailure[] = [];
  private failureCount = 0;
  private candidates = 0;
  private scanCeilingReached = false;
  private readonly startedAt = new Date().toISOString();

  /** A File entered the candidate set. Called once per File read. */
  candidate(): void {
    this.candidates++;
  }

  /** The scan stopped short, so the candidate set does not cover the corpus. */
  ceilingReached(): void {
    this.scanCeilingReached = true;
  }

  record(fileId: string, outcome: SweepOutcome, detail?: { direction?: InvoiceDirection; message?: string }): void {
    this.outcomes[outcome]++;

    if (detail?.direction) {
      this.byDirection[detail.direction]++;
    }

    if (outcome === "evaluation-failed" || outcome === "write-rejected") {
      this.failureCount++;
      if (this.failures.length < MAX_NAMED_FAILURES) {
        this.failures.push({ fileId, outcome, message: detail?.message ?? "" });
      }
    }
  }

  summarise(runId: string, userId: string): InvoiceDirectionSweepSummary {
    let accounted = 0;
    let evaluated = 0;
    let neverEvaluated = 0;

    for (const [outcome, count] of Object.entries(this.outcomes) as Array<[SweepOutcome, number]>) {
      accounted += count;
      if (NEVER_EVALUATED.has(outcome)) neverEvaluated += count;
      else evaluated += count;
    }

    return {
      runId,
      userId,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      candidates: this.candidates,
      outcomes: { ...this.outcomes },
      evaluated,
      neverEvaluated,
      byDirection: { ...this.byDirection },
      failures: [...this.failures],
      failuresTruncated: this.failureCount > this.failures.length,
      // A File evaluated but neither written nor attributed to a named skip
      // reason would break the first term: that is the run reporting itself
      // as failed rather than as a success with a short report.
      complete:
        accounted === this.candidates &&
        this.failureCount === 0 &&
        !this.scanCeilingReached,
      scanCeilingReached: this.scanCeilingReached,
    };
  }
}

/** One File's re-derived state, held until the commit decides its fate. */
export interface PlannedFileWrite {
  ref: FirebaseFirestore.DocumentReference;
  fileId: string;
  updates: Record<string, unknown>;
  /** The direction the derivation produced, for the run's direction counts. */
  direction: InvoiceDirection;
  /** Transactions whose documentation state moves only if this write lands. */
  affectedTransactionIds: string[];
}

/**
 * Write the plan, and give every File in it a verdict.
 *
 * A failing batch cannot say which File it choked on: firebase-admin rejects
 * the whole commit, while the self-host shim applies its ops in order and
 * stops at the bad one. So one refused payload loses either all of a batch or
 * an arbitrary tail of it, with nothing recording which — that is #158, and it
 * is why the skipped Files' creation timestamps sat inside the range of the
 * ones that flipped: a batch is ordered by document id, not by creation time.
 *
 * On a failure the chunk is replayed one File at a time, which costs nothing
 * on the happy path and turns "some were written and some were not" into a
 * named list. Replaying over a partly-applied chunk is safe: every payload was
 * computed before the commit, `updatedAt` included, so a File written twice is
 * written the same twice.
 *
 * `commitChunk` is the caller's batched write. It is a parameter so the
 * attribution can be driven against a store that refuses, which is the one
 * path that must not be exercised for the first time in production.
 *
 * Returns the transaction ids of the writes that actually landed.
 */
export async function commitSweepWrites(
  planned: PlannedFileWrite[],
  ledger: SweepLedger,
  commitChunk: (chunk: PlannedFileWrite[]) => Promise<void>,
  chunkSize: number
): Promise<Set<string>> {
  const affectedTransactionIds = new Set<string>();

  const landed = (write: PlannedFileWrite) => {
    ledger.record(write.fileId, "written", { direction: write.direction });
    for (const transactionId of write.affectedTransactionIds) {
      affectedTransactionIds.add(transactionId);
    }
  };

  for (let i = 0; i < planned.length; i += chunkSize) {
    const chunk = planned.slice(i, i + chunkSize);

    try {
      await commitChunk(chunk);
      for (const write of chunk) landed(write);
      continue;
    } catch (error) {
      console.error(
        `[onUserDataUpdate] batched commit of ${chunk.length} files failed, ` +
        "replaying one at a time to attribute it:",
        error
      );
    }

    for (const write of chunk) {
      try {
        await write.ref.update(write.updates);
        landed(write);
      } catch (error) {
        ledger.record(write.fileId, "write-rejected", {
          direction: write.direction,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return affectedTransactionIds;
}

/** One line, so a log reader sees the same numbers the stored record holds. */
export function formatSweepSummary(summary: InvoiceDirectionSweepSummary): string {
  const outcomes = (Object.entries(summary.outcomes) as Array<[SweepOutcome, number]>)
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${outcome}=${count}`)
    .join(" ");

  return (
    `[onUserDataUpdate] sweep ${summary.runId} user ${summary.userId} ` +
    `${summary.complete ? "complete" : "INCOMPLETE"}: ` +
    `${summary.candidates} candidates (${outcomes || "none"}), ` +
    `directions incoming=${summary.byDirection.incoming} ` +
    `outgoing=${summary.byDirection.outgoing} unknown=${summary.byDirection.unknown}`
  );
}

/**
 * Persist the run so it can be read after the fact.
 *
 * A log line is not enough: the observation that opened #158 was made days
 * later, against `updatedAt` values, because there was nothing else left to
 * look at. Written server-side only — `directionSweeps` is client-readable so
 * the surfaces that consume `invoiceDirection` can check `complete` before
 * presenting their numbers as whole.
 */
export async function persistSweepSummary(
  summary: InvoiceDirectionSweepSummary
): Promise<void> {
  try {
    await getFirestore()
      .collection(`users/${summary.userId}/directionSweeps`)
      .doc(summary.runId)
      .set({ ...summary, createdAt: Timestamp.now() });
  } catch (error) {
    // The sweep's writes already landed; losing the record of them is bad but
    // it is not a reason to fail the trigger and re-run the whole thing.
    console.error(`[onUserDataUpdate] could not persist sweep ${summary.runId}:`, error);
  }
}
