/**
 * Durable, cross-process trigger delivery — the enqueue half.
 *
 * ## Why this exists
 *
 * Trigger dispatch rides the in-process bus in `bus.ts`, and `enableAutoDrain()`
 * is called in exactly one place: `server.ts`, the fibuki-api entrypoint. The
 * Next app under `app/api/**` runs in the fibuki-web container and writes
 * through the SAME `firestore-shim` (see `lib/selfhost/admin-shim.ts`), so its
 * writes emitted onto *that* process's bus — which has no handlers registered
 * and nothing draining it. Every trigger whose originating write came from a
 * web route was dead in deployment: nothing threw, nothing logged, and the same
 * call site behaved correctly from fibuki-api or under test.
 *
 * `change-notify.ts` already explains why the bus is the wrong tool for
 * crossing that boundary. It is also the wrong tool for a second reason: the
 * bus is in memory, so an API restart loses whatever it had queued.
 *
 * This is the fix the issue asked for — a queue in Postgres rather than in
 * memory, so ANY writer enqueues and the dispatching process drains. It
 * generalises where the J3 hand-patch did not: a new trigger cannot be born
 * dead, because delivery no longer depends on which container made the write.
 *
 * ## The transactional part matters
 *
 * The insert runs on the write's OWN connection, inside the write's
 * transaction, exactly like `notifyChange()`. A rolled-back write therefore
 * leaves no event, and a committed write cannot fail to leave one. Doing it
 * after commit would open a window where a crash drops the trigger silently —
 * which is the failure mode this whole file exists to remove.
 *
 * This half deliberately imports nothing from `firestore-shim`, so the shim can
 * import it without a cycle. The drain half lives in `trigger-queue-drain.ts`.
 */

/** Query runner shape — the shim's `q`, so the insert joins the write's transaction. */
type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

let durable = false;

/**
 * Opt this process into durable trigger delivery: its writes append to
 * `trigger_events` instead of emitting onto the in-process bus.
 *
 * Deliberately opt-IN rather than inferred from `enableAutoDrain()`. The tests
 * do not auto-drain either — they drive `drainTriggers()` by hand — so keying
 * off "does not auto-drain" would have silently routed the whole suite through
 * the durable path and broken every in-process trigger assertion. The one
 * process that genuinely needs this is fibuki-web, and it has an unambiguous
 * marker: `lib/selfhost/admin-shim.ts` is loaded in that container and nowhere
 * else, so it is the caller.
 */
export function useDurableTriggerQueue(): void {
  durable = true;
}

/** True when writes from this process go to `trigger_events` rather than the bus. */
export function usesDurableTriggerQueue(): boolean {
  return durable;
}

/** Test helper: restore the default (in-process) delivery mode. */
export function __resetTriggerQueueMode(): void {
  durable = false;
}

/** A document change, with `before`/`after` already wire-encoded by the shim. */
export interface EncodedTriggerEvent {
  collectionPath: string;
  id: string;
  path: string;
  /** Wire-encoded previous document, or undefined when the write was a create. */
  before: unknown;
  /** Wire-encoded next document, or undefined when the write was a delete. */
  after: unknown;
}

/**
 * Append a change to the durable trigger queue on the CURRENT transaction.
 *
 * Never throws. The queue is a delivery mechanism, not the write itself: losing
 * an event costs a trigger, while letting the insert abort the transaction
 * would cost the user's data. That trade is only defensible because the failure
 * is loud — an enqueue that fails logs, unlike the silent bus drop it replaces.
 */
export async function enqueueTriggerEvent(
  exec: Exec,
  tenantId: string,
  event: EncodedTriggerEvent,
): Promise<void> {
  try {
    await exec(
      `INSERT INTO trigger_events
         (tenant_id, collection_path, doc_id, path, before, after)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        tenantId,
        event.collectionPath,
        event.id,
        event.path,
        event.before === undefined ? null : JSON.stringify(event.before),
        event.after === undefined ? null : JSON.stringify(event.after),
      ],
    );
  } catch (err) {
    console.error(
      `selfhost trigger-queue: failed to enqueue ${event.path} — its triggers will not fire:`,
      err,
    );
  }
}
