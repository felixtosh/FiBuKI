/**
 * Durable, cross-process trigger delivery — the drain half.
 *
 * Runs in the dispatching process (fibuki-api). Claims events that other
 * processes appended to `trigger_events`, feeds each one through the ordinary
 * in-process bus, and deletes it once dispatched.
 *
 * Feeding the existing bus rather than calling the trigger registry directly is
 * deliberate: `bus.ts` + `trigger-shim.ts` already own event shaping, the
 * created/updated/deleted decision, handler error isolation and the cascade
 * loop guard. A queued event should behave identically to a local one, and the
 * cheapest way to guarantee that is to make it literally the same code path.
 *
 * Cascades stay in memory. A handler's own writes happen in THIS process, which
 * does not use the durable queue, so they emit onto the bus and drain inline —
 * the queue carries only the cross-container hop, not the whole cascade.
 *
 * ## Ordering
 *
 * Events are claimed one at a time, at dispatch, in `seq` order, so a single
 * drainer preserves write order. Claiming a batch up front (it used to be 20)
 * let the tail of the batch sit claimed while the head dispatched; past the
 * claim window another pass took it for abandoned and dispatched it again
 * (#603). While a handler runs, its claim is kept fresh for the same reason. Two API replicas can interleave, because
 * `SKIP LOCKED` lets each claim a different row — the same weak ordering real
 * Firestore gives, where concurrent trigger invocations have no relative order.
 */

import { drainChanges, emitChange } from "./bus";
import { getSqlClient, __decodeDocValue } from "./firestore-shim";
import { getTenantId } from "./db/tenant";

/**
 * How long a claim may go unrefreshed before another pass may reclaim it. A
 * dispatching drainer refreshes its claim well inside this, so only a dead
 * process's claim runs out.
 */
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Claims before a row is treated as poison and left alone. Only process death
 * mid-dispatch increments this without progress (a throwing handler is caught
 * and logged by the trigger shim), so reaching the cap means the event itself
 * is killing the container — retrying it forever would turn one bad document
 * into a crash loop that starves every other trigger.
 */
const MAX_ATTEMPTS = 5;

/** Idle poll interval. The floor under LISTEN, not the primary wake signal. */
const POLL_INTERVAL_MS = 2000;

interface ClaimedRow {
  seq: number;
  collection_path: string;
  doc_id: string;
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * Put rows back that a dead process left claimed.
 *
 * Returns them to the pool rather than deleting: the write they describe is
 * committed, so dropping the event would silently lose the trigger — the exact
 * failure this module exists to remove.
 */
async function reclaimStale(
  q: (sql: string, params?: unknown[]) => Promise<unknown>,
  claimTimeoutMs: number,
): Promise<void> {
  await q(
    `UPDATE trigger_events SET claimed_at = NULL
      WHERE tenant_id = $1 AND claimed_at IS NOT NULL AND claimed_at < $2 AND attempts < $3`,
    [getTenantId(), new Date(Date.now() - claimTimeoutMs), MAX_ATTEMPTS],
  );
}

export interface TriggerQueueDrainOptions {
  /** Override the claim window. Tests shrink it; nothing else should. */
  claimTimeoutMs?: number;
}

/**
 * Claim, dispatch and delete one event. Returns 1 when an event was handled
 * and 0 when none was waiting, so the caller can keep draining.
 */
export async function drainTriggerQueueOnce(opts: TriggerQueueDrainOptions = {}): Promise<number> {
  const pg = await getSqlClient();
  const tenantId = getTenantId();
  const claimTimeoutMs = opts.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

  // Claim in its own short transaction. Holding it across dispatch would pin a
  // pooled connection for the whole of a slow handler, and at
  // POSTGRES_MAX_CONNECTIONS=25 a handful of those is the entire pool.
  const row = await pg.tx(tenantId, async (q) => {
    await reclaimStale(q, claimTimeoutMs);
    const res = await q<ClaimedRow>(
      `UPDATE trigger_events
          SET claimed_at = now(), attempts = attempts + 1
        WHERE seq = (
          SELECT seq FROM trigger_events
           WHERE tenant_id = $1 AND claimed_at IS NULL AND attempts < $2
           ORDER BY seq
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
      RETURNING seq, collection_path, doc_id, path, before, after`,
      [tenantId, MAX_ATTEMPTS],
    );
    return res.rows[0];
  });

  if (!row) return 0;

  const heartbeat = setInterval(
    () =>
      void pg
        .tx(tenantId, (q) =>
          q(`UPDATE trigger_events SET claimed_at = now() WHERE tenant_id = $1 AND seq = $2`, [
            tenantId,
            row.seq,
          ]),
        )
        .catch((err) =>
          console.error(`selfhost trigger-queue: could not refresh the claim on ${row.path}:`, err),
        ),
    Math.max(10, Math.min(60 * 1000, claimTimeoutMs / 4)),
  );
  heartbeat.unref?.();

  try {
    // SQL NULL on a side means "no document there": null before = create,
    // null after = delete. undefined is what the bus and trigger shim read.
    emitChange({
      collectionPath: row.collection_path,
      id: row.doc_id,
      path: row.path,
      before:
        row.before === null
          ? undefined
          : (__decodeDocValue(row.before) as Record<string, unknown>),
      after:
        row.after === null ? undefined : (__decodeDocValue(row.after) as Record<string, unknown>),
    });

    // Dispatch this event and any cascade it starts before claiming the next,
    // so the queue drains in order rather than interleaving.
    await drainChanges();
  } finally {
    clearInterval(heartbeat);
  }

  await pg.tx(tenantId, (q) =>
    q(`DELETE FROM trigger_events WHERE tenant_id = $1 AND seq = $2`, [tenantId, row.seq]),
  );

  return 1;
}

/**
 * Drain until the queue is empty, then report how many events were delivered.
 * Separate from the loop below so boot and tests can drain deterministically.
 */
export async function drainTriggerQueue(opts: TriggerQueueDrainOptions = {}): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await drainTriggerQueueOnce(opts);
    if (n === 0) return total;
    total += n;
  }
}

export interface TriggerQueueRunner {
  stop: () => void;
}

/**
 * Start the background drain in the dispatching process.
 *
 * Polling rather than LISTEN/NOTIFY on purpose, at least here: the queue's
 * whole point is that delivery survives an API restart, and a notification
 * delivered while nobody was listening is gone. A poll re-reads committed state
 * every interval, so the worst case of a missed wake-up is latency rather than
 * a lost trigger. `change-notify.ts`'s channel can be layered on later as a
 * latency optimisation without changing this correctness argument.
 */
export function startTriggerQueueDrain(
  opts: { intervalMs?: number; log?: (m: string) => void } = {},
): TriggerQueueRunner {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const log = opts.log ?? ((m: string) => console.log(m));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const n = await drainTriggerQueue();
      if (n > 0) log(`selfhost trigger-queue: delivered ${n} cross-process event(s)`);
    } catch (err) {
      // Never let a transient database error kill the loop — that would stop
      // every web-originated trigger until the next restart.
      console.error("selfhost trigger-queue: drain failed, retrying next tick:", err);
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref?.();
    }
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
