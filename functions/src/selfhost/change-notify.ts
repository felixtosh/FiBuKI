/**
 * Cross-process change notification over Postgres LISTEN/NOTIFY.
 *
 * ## Why this exists
 *
 * `onSnapshot` is emulated by polling on the self-host stack, so a change takes up
 * to a poll interval to reach the browser. A write made by THIS tab is already
 * handled — lib/selfhost/poll-bus.ts pokes the pollers directly. What that cannot
 * cover is everything else, which is most of what feels slow:
 *
 *   - extraction finishing, minutes after the upload callable returned
 *   - matching resolving, or a receipt search landing
 *   - the cron host processing a queue
 *   - another session, or another API replica
 *
 * Those all happen server-side, in a different process from the browser that cares.
 * Postgres is the one thing every writer already shares, so it is the natural fan-out
 * point.
 *
 * The in-process trigger bus (bus.ts) is deliberately NOT used for this: it does not
 * cross process boundaries, which is the entire problem, and it would silently work
 * in single-replica development while failing in any deployment with a separate
 * worker.
 *
 * ## Semantics that matter
 *
 * `pg_notify` inside a transaction is queued and delivered ONLY on commit, so a
 * rolled-back write never produces a notification. That is why the notify is issued
 * on the same connection as the write rather than afterwards — doing it post-commit
 * would open a window where a crash loses the notification, and would cost an extra
 * round trip.
 *
 * Payloads are capped at 8000 bytes by Postgres, so this sends identity only
 * (tenant, collection, id) and never document contents. The client refetches through
 * the ordinary authenticated data plane, which means the stream can never become a
 * way to read data you are not entitled to.
 */

export const CHANGE_CHANNEL = "fibuki_changes";

export interface ChangeNotification {
  /** Tenant the change belongs to. Subscribers MUST filter on this. */
  tenant: string;
  /** Collection path, e.g. "transactions" or "users/u1/settings". */
  collection: string;
  /** Document id within that collection. */
  id: string;
  /** "w" for write (create/update), "d" for delete. Kept terse for the 8KB cap. */
  op: "w" | "d";
}

/** Query runner shape — the shim's `q`, so the notify joins the write's transaction. */
type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Queue a change notification on the CURRENT transaction.
 *
 * Never throws: a failed notification must not roll back the write that caused it.
 * Realtime is an optimisation over polling, and polling is still the fallback, so
 * losing a notification degrades latency rather than correctness.
 */
export async function notifyChange(
  exec: Exec,
  change: ChangeNotification,
): Promise<void> {
  try {
    const payload = JSON.stringify(change);
    // Guard the 8000-byte NOTIFY limit. Identity-only payloads are far below it, but
    // a pathological collection path or document id should degrade rather than
    // abort the transaction.
    if (payload.length > 7000) return;
    await exec(`SELECT pg_notify($1, $2)`, [CHANGE_CHANNEL, payload]);
  } catch {
    /* realtime is best-effort; the poll fallback still converges */
  }
}

/** Parse a payload received on the channel. Returns null for anything malformed. */
export function parseChangeNotification(raw: string): ChangeNotification | null {
  try {
    const v = JSON.parse(raw) as Partial<ChangeNotification>;
    if (
      typeof v.tenant === "string" &&
      typeof v.collection === "string" &&
      typeof v.id === "string" &&
      (v.op === "w" || v.op === "d")
    ) {
      return v as ChangeNotification;
    }
  } catch {
    /* fall through */
  }
  return null;
}
