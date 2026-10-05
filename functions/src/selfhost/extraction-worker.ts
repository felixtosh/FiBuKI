/**
 * The extraction worker (#603).
 *
 * Extraction used to run inside the trigger queue, which dispatches one
 * event at a time: at 10 to 30 seconds a File that held up, and with a slow
 * Extraction Service (a local model, minutes per File) one large upload held
 * every other trigger for hours. Now the trigger only writes a job into
 * `extraction_jobs` and returns; this worker claims jobs and runs them.
 * Gemini and an external Extraction Service go through the same worker.
 *
 * ## Claims
 *
 * A claim is one short transaction (`SKIP LOCKED`), so every fibuki-api
 * replica can run a worker without a lock and no job is claimed twice. The
 * claim takes the oldest waiting job of the user served least recently:
 * fibuki.com is one tenant with many users, and a 200-File upload must not
 * hold another user's single File.
 *
 * While a job runs, its worker refreshes `claimed_at`. A claim older than the
 * extraction timeout plus a minute therefore belongs to a worker that died,
 * and goes back to waiting with `attempts` raised; after three of those the
 * File is marked failed instead. A failed Extraction is not retried by
 * itself (#161 decision 4); `attempts` counts only dead workers.
 *
 * ## One run per File
 *
 * A run cannot be cancelled. When it outlasts the timeout the File is marked
 * failed at once, but the claim stays held and the slot stays taken until the
 * run actually ends, so the File is never extracted by two runs at once and a
 * local model never gets more documents than the concurrency allows. A Retry
 * that arrives while the File runs sets `rerun`; the job then waits again
 * when the run ends instead of being deleted, and its next claim applies the
 * Retry's reset before extracting (`reset_on_claim`).
 */

import { randomUUID } from "crypto";
import { getSqlClient } from "./firestore-shim";
import { getTenantId } from "./db/tenant";
import type { ExtractionRequest } from "../extraction/extractionQueue";
import { extractQueuedFile, recordExtractionFailure } from "../extraction/extractQueuedFile";
import {
  externalExtractionServiceConfigured,
  extractionTimeoutMs,
} from "../extraction/extractionService";

/** Reclaims after which a File is marked failed rather than put back again. */
export const MAX_RECLAIMS = 3;

/** Idle poll interval. A finished run wakes the worker at once. */
const POLL_INTERVAL_MS = 2000;

/** Concurrency per replica with the built-in Gemini: close to the old bulk retry. */
const GEMINI_CONCURRENCY = 4;

function positiveNumberFromEnv(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The service configuration and the timeout live with the Extraction Service
// contract (#161), so the worker and the service call agree on both.
export { externalExtractionServiceConfigured, extractionTimeoutMs };

/**
 * How many Extractions one replica runs at once. One local model rarely
 * takes more than one document at a time.
 */
export function extractionConcurrency(): number {
  const n = positiveNumberFromEnv("FIBUKI_EXTRACTION_CONCURRENCY");
  if (n) return Math.floor(n);
  return externalExtractionServiceConfigured() ? 1 : GEMINI_CONCURRENCY;
}

export interface ExtractionTiming {
  /** How long one Extraction may run before its File is marked failed. */
  timeoutMs?: number;
  /**
   * A claim not refreshed for this long belongs to a worker that died. The
   * timeout plus a minute; tests shrink it, nothing else should.
   */
  claimWindowMs?: number;
}

function resolveTiming(timing: ExtractionTiming): Required<ExtractionTiming> {
  const timeoutMs = timing.timeoutMs ?? extractionTimeoutMs();
  return { timeoutMs, claimWindowMs: timing.claimWindowMs ?? timeoutMs + 60 * 1000 };
}

type Exec = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

async function inTenant<T>(fn: (q: Exec) => Promise<T>): Promise<T> {
  const pg = await getSqlClient();
  return pg.tx(getTenantId(), fn as never);
}

/**
 * Write the job for one File. Returns at once; the worker does the rest.
 *
 * A `new` request yields to a job already there: the File waits once, not
 * once per caller. A `retry` replaces the waiting job's options and reclaim
 * count, and on a File that is running right now it asks for one more run
 * after this one.
 */
export async function enqueueExtractionJob(request: ExtractionRequest): Promise<void> {
  const params = [getTenantId(), request.fileId, request.userId, request.skipClassification];
  await inTenant((q) =>
    request.kind === "new"
      ? q(
          `INSERT INTO extraction_jobs (tenant_id, file_id, user_id, skip_classification)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, file_id) DO NOTHING`,
          params,
        )
      : q(
          `INSERT INTO extraction_jobs (tenant_id, file_id, user_id, skip_classification)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, file_id) DO UPDATE
             SET skip_classification = EXCLUDED.skip_classification,
                 user_id = EXCLUDED.user_id,
                 attempts = 0,
                 rerun = extraction_jobs.claimed_at IS NOT NULL`,
          params,
        ),
  );
}

/**
 * Put back the jobs of workers that died, and fail the Files whose jobs
 * have now been put back too often.
 */
export async function reclaimAbandonedExtractions(timing: ExtractionTiming = {}): Promise<void> {
  const { claimWindowMs } = resolveTiming(timing);
  const exhausted = await inTenant(async (q) => {
    await q(
      `UPDATE extraction_jobs
          SET claimed_at = NULL, claim_token = NULL, rerun = false, attempts = attempts + 1
        WHERE tenant_id = $1 AND claimed_at IS NOT NULL
          AND claimed_at < now() - ($2::double precision * interval '1 millisecond')`,
      [getTenantId(), claimWindowMs],
    );
    const res = await q(
      `DELETE FROM extraction_jobs
        WHERE tenant_id = $1 AND claimed_at IS NULL AND attempts >= $2
      RETURNING file_id`,
      [getTenantId(), MAX_RECLAIMS],
    );
    return res.rows.map((r) => String(r.file_id));
  });

  for (const fileId of exhausted) {
    console.error(`extraction worker: file ${fileId} did not finish after ${MAX_RECLAIMS} attempts`);
    try {
      await recordExtractionFailure(
        fileId,
        `Extraction did not finish after ${MAX_RECLAIMS} attempts.`,
      );
    } catch (err) {
      // The File is gone; there is nobody left to tell.
      console.error(`extraction worker: could not mark file ${fileId} failed:`, err);
    }
  }
}

export interface ClaimedExtractionJob {
  fileId: string;
  userId: string;
  skipClassification: boolean;
  /** A Retry arrived while the File last ran: apply its reset before extracting. */
  resetFirst: boolean;
  /** Names this claim, so a reclaimed worker cannot touch the next owner's row. */
  token: string;
}

/** Claim the next job: the oldest waiting job of the user served least recently. */
export async function claimExtractionJob(): Promise<ClaimedExtractionJob | null> {
  const tenantId = getTenantId();
  const token = randomUUID();
  return inTenant(async (q) => {
    const res = await q(
      `UPDATE extraction_jobs
          SET claimed_at = now(), claim_token = $2
        WHERE tenant_id = $1 AND file_id = (
          SELECT j.file_id
            FROM extraction_jobs j
            LEFT JOIN extraction_turns t
              ON t.tenant_id = j.tenant_id AND t.user_id = j.user_id
           WHERE j.tenant_id = $1 AND j.claimed_at IS NULL
           ORDER BY t.last_claimed_at ASC NULLS FIRST, j.created_at, j.file_id
           LIMIT 1
           FOR UPDATE OF j SKIP LOCKED
        )
      RETURNING file_id, user_id, skip_classification, reset_on_claim`,
      [tenantId, token],
    );
    const row = res.rows[0];
    if (!row) return null;

    // clock_timestamp, not now(): two claims in one transaction snapshot
    // must still order.
    await q(
      `INSERT INTO extraction_turns (tenant_id, user_id, last_claimed_at)
       VALUES ($1, $2, clock_timestamp())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at`,
      [tenantId, row.user_id],
    );

    return {
      fileId: String(row.file_id),
      userId: String(row.user_id),
      skipClassification: row.skip_classification === true,
      resetFirst: row.reset_on_claim === true,
      token,
    };
  });
}

/** Keep a running job's claim fresh, so nobody takes it for abandoned. */
async function touchClaim(job: ClaimedExtractionJob): Promise<void> {
  await inTenant((q) =>
    q(
      `UPDATE extraction_jobs SET claimed_at = now()
        WHERE tenant_id = $1 AND file_id = $2 AND claim_token = $3`,
      [getTenantId(), job.fileId, job.token],
    ),
  );
}

/** The run ended: delete the job, or put it back when a Retry asked for another run. */
async function finishJob(job: ClaimedExtractionJob): Promise<void> {
  await inTenant(async (q) => {
    const params = [getTenantId(), job.fileId, job.token];
    await q(
      `DELETE FROM extraction_jobs
        WHERE tenant_id = $1 AND file_id = $2 AND claim_token = $3 AND NOT rerun`,
      params,
    );
    await q(
      `UPDATE extraction_jobs
          SET claimed_at = NULL, claim_token = NULL, rerun = false, reset_on_claim = true
        WHERE tenant_id = $1 AND file_id = $2 AND claim_token = $3`,
      params,
    );
  });
}

/**
 * This process is shutting down (a deploy restarts every replica). Hand the
 * job back as it was, without counting an attempt: frequent deploys must not
 * add up to a failed File.
 */
async function handBackJob(job: ClaimedExtractionJob): Promise<void> {
  await inTenant((q) =>
    q(
      `UPDATE extraction_jobs SET claimed_at = NULL, claim_token = NULL
        WHERE tenant_id = $1 AND file_id = $2 AND claim_token = $3`,
      [getTenantId(), job.fileId, job.token],
    ),
  );
}

/**
 * The run broke before it could record an outcome (the database went away,
 * say). Put the job back as a dead worker would have left it, so the
 * reclaim cap applies.
 */
async function releaseJob(job: ClaimedExtractionJob): Promise<void> {
  await inTenant((q) =>
    q(
      `UPDATE extraction_jobs
          SET claimed_at = NULL, claim_token = NULL, rerun = false, attempts = attempts + 1
        WHERE tenant_id = $1 AND file_id = $2 AND claim_token = $3`,
      [getTenantId(), job.fileId, job.token],
    ),
  );
}

const TIMED_OUT = Symbol("timed out");

/** Run one claimed job to its end. Never throws. */
export async function runExtractionJob(
  job: ClaimedExtractionJob,
  timing: ExtractionTiming = {},
): Promise<void> {
  const { timeoutMs, claimWindowMs } = resolveTiming(timing);
  const heartbeat = setInterval(
    () =>
      void touchClaim(job).catch((err) =>
        console.error(`extraction worker: could not refresh the claim on ${job.fileId}:`, err),
      ),
    Math.max(10, Math.min(30 * 1000, claimWindowMs / 4)),
  );
  heartbeat.unref?.();

  let broken = false;
  try {
    const run = extractQueuedFile(job.fileId, {
      skipClassification: job.skipClassification,
      resetFirst: job.resetFirst,
    });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      run,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));

    if (outcome === TIMED_OUT) {
      const seconds = Math.round(timeoutMs / 1000);
      console.error(`extraction worker: file ${job.fileId} did not finish within ${seconds}s`);
      await recordExtractionFailure(job.fileId, `Extraction did not finish within ${seconds} seconds.`);
      // Hold the claim and the slot until the run really ends: see the header.
      await run.catch(() => undefined);
    }
  } catch (err) {
    broken = true;
    console.error(`extraction worker: run for file ${job.fileId} broke, putting it back:`, err);
  } finally {
    clearInterval(heartbeat);
  }

  try {
    await (broken ? releaseJob(job) : finishJob(job));
  } catch (err) {
    // The claim then runs out and the reclaim sweep puts the job back.
    console.error(`extraction worker: could not settle the job for file ${job.fileId}:`, err);
  }
}

/**
 * Claim and run jobs one at a time until none is waiting. For boot-free use
 * and the tests; the deployed process runs `startExtractionWorker`.
 */
export async function drainExtractionQueue(timing: ExtractionTiming = {}): Promise<number> {
  let n = 0;
  for (;;) {
    await reclaimAbandonedExtractions(timing);
    const job = await claimExtractionJob();
    if (!job) return n;
    await runExtractionJob(job, timing);
    n++;
  }
}

export interface ExtractionWorker {
  /** Stop claiming, and hand back the jobs still running here. */
  stop: () => Promise<void>;
}

/**
 * Start the worker in this process. Runs in every fibuki-api replica; claims
 * are safe without a lock, so the schedules-owner switch is not involved.
 */
export function startExtractionWorker(
  opts: ExtractionTiming & { concurrency?: number; intervalMs?: number } = {},
): ExtractionWorker {
  const concurrency = opts.concurrency ?? extractionConcurrency();
  const timing = resolveTiming(opts);
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;

  let stopped = false;
  const running = new Set<ClaimedExtractionJob>();
  let ticking = false;
  let tickAgain = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (ticking) {
      tickAgain = true;
      return;
    }
    ticking = true;
    try {
      await reclaimAbandonedExtractions(timing);
      while (!stopped && running.size < concurrency) {
        const job = await claimExtractionJob();
        if (!job) break;
        running.add(job);
        void runExtractionJob(job, timing).finally(() => {
          running.delete(job);
          schedule(0);
        });
      }
    } catch (err) {
      // A transient database error must not end the loop: every upload would
      // then wait for the next restart.
      console.error("extraction worker: claim failed, retrying next tick:", err);
    } finally {
      ticking = false;
    }
    if (tickAgain) {
      tickAgain = false;
      schedule(0);
    } else {
      schedule(intervalMs);
    }
  };

  console.log(
    `extraction worker: ${concurrency} at a time, ${Math.round(timing.timeoutMs / 1000)}s timeout`,
  );
  void tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.allSettled([...running].map((job) => handBackJob(job)));
    },
  };
}
