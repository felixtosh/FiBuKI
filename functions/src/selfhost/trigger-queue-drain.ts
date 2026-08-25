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
 * Events are claimed in `seq` order and dispatched one at a time, so a single
 * drainer preserves write order. Two API replicas can interleave, because
 * `SKIP LOCKED` lets each claim a different row — the same weak ordering real
 * Firestore gives, where concurrent trigger invocations have no relative order.
 */

import { drainChanges, emitChange } from "./bus";
import { getSqlClient, __decodeDocValue } from "./firestore-shim";
import { getTenantId } from "./db/tenant";

/** Rows claimed per drain pass. Bounds one transaction's work, not the queue. */
const CLAIM_BATCH = 20;

/**
 * How long a claimed row may stay in flight before another pass may reclaim it.
 * Must exceed the slowest realistic handler — extraction and matching run for
 * minutes — or a slow trigger gets dispatched twice concurrently.
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
async function reclaimStale(q: (sql: string, params?: unknown[]) => Promise<unknown>): Promise<void> {
  await q(
    `UPDATE trigger_events SET claimed_at = NULL
      WHERE tenant_id = $1 AND claimed_at IS NOT NULL AND claimed_at < $2 AND attempts < $3`,
    [getTenantId(), new Date(Date.now() - CLAIM_TIMEOUT_MS), MAX_ATTEMPTS],
  );
}

/**
 * Claim, dispatch and delete one batch. Returns how many events were handled,
 * so the caller can keep draining while the queue is non-empty.
 */
export async function drainTriggerQueueOnce(): Promise<number> {
  const pg = await getSqlClient();
  const tenantId = getTenantId();

  // Claim in its own short transaction. Holding it across dispatch would pin a
  // pooled connection for the whole of a multi-minute extraction handler, and
  // at POSTGRES_MAX_CONNECTIONS=25 a handful of those is the entire pool.
  const claimed = await pg.tx(tenantId, async (q) => {
    await reclaimStale(q);
    const res = await q<ClaimedRow>(
      `UPDATE trigger_events
          SET claimed_at = now(), attempts = attempts + 1
        WHERE seq IN (
          SELECT seq FROM trigger_events
           WHERE tenant_id = $1 AND claimed_at IS NULL AND attempts < $2
           ORDER BY seq
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
      RETURNING seq, collection_path, doc_id, path, before, after`,
      [tenantId, MAX_ATTEMPTS, CLAIM_BATCH],
    );
    return res.rows;
  });

  if (claimed.length === 0) return 0;

  // RETURNING does not promise the UPDATE's row order.
  claimed.sort((a, b) => Number(a.seq) - Number(b.seq));

  for (const row of claimed) {
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

    // Dispatch this event and any cascade it starts before moving on, so the
    // queue drains in order rather than interleaving with the next event.
    await drainChanges();

    await pg.tx(tenantId, (q) =>
      q(`DELETE FROM trigger_events WHERE tenant_id = $1 AND seq = $2`, [tenantId, row.seq]),
    );
  }

  return claimed.length;
}

/**
 * Drain until the queue is empty, then report how many events were delivered.
 * Separate from the loop below so boot and tests can drain deterministically.
 */
export async function drainTriggerQueue(): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await drainTriggerQueueOnce();
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
