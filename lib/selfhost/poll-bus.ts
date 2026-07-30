/**
 * A tiny in-process bus that lets a write nudge every active `onSnapshot` poller
 * into refetching immediately, instead of waiting out its interval.
 *
 * ## Why
 *
 * Realtime is polling on the self-host stack (`onSnapshot` becomes a
 * `setInterval`, currently 5s). That is fine for changes made elsewhere, but it
 * makes the user's OWN actions feel broken: you click something, the callable
 * succeeds, and the row does not change for up to a full interval. The data is
 * already correct on the server — the client simply has not looked yet.
 *
 * So on every successful mutation, poke. The client knows something changed at
 * that exact moment, which is strictly better information than a timer has.
 * Genuine push (ElectricSQL) is Phase 3 and still worth doing, because this
 * covers only changes THIS tab caused; a background worker or another session
 * still waits for the next tick.
 *
 * ## Why a separate module
 *
 * `firestore-client.ts` owns the pollers and `functions-client.ts` owns callable
 * mutations, and those two deliberately do not import each other — they alias to
 * different upstream modules (`firebase/firestore` vs `firebase/functions`) at
 * build time, and a cross-import would couple the two swaps together. This module
 * imports nothing, so both can depend on it without creating that edge.
 *
 * Deliberately not exported through any shim's public surface: it has no Firebase
 * counterpart, so application code must never reach for it.
 */

type Poller = () => void;

const pollers = new Set<Poller>();

/**
 * Register a poller's "check now" function. Returns an unsubscribe that MUST be
 * called when the listener tears down, or a long session accumulates dead
 * closures that fire on every mutation.
 */
export function registerPoller(poll: Poller): () => void {
  pollers.add(poll);
  return () => {
    pollers.delete(poll);
  };
}

/**
 * Ask every active poller to refetch now.
 *
 * Never throws: a mutation must not fail because a subscriber's refetch did. Each
 * poller already guards against overlapping requests, so a poke during an in-flight
 * tick is dropped rather than doubled.
 */
export function pokePollers(): void {
  for (const poll of pollers) {
    try {
      poll();
    } catch {
      /* a broken subscriber must not break the write that triggered it */
    }
  }
}

/** Test/diagnostic hook: how many listeners would a poke reach. */
export function __pollerCount(): number {
  return pollers.size;
}

/* ------------------------------------------------------------------ */
/* Stream health                                                       */
/* ------------------------------------------------------------------ */

/**
 * Whether the realtime SSE stream is currently delivering.
 *
 * Polling exists to catch changes the client was never told about. While the
 * stream is up it IS being told, so the timer becomes a safety net rather than the
 * primary mechanism and can run far slower — a straight reduction in idle request
 * volume, which at 5s and ~8 live listeners per tab was the bulk of the app's
 * traffic.
 *
 * Defaults to false so a deployment with no stream (same-origin, unconfigured, or
 * a database without LISTEN) keeps today's responsive polling. The safety net is
 * never removed entirely: a stream can be up and still miss an event, and a slow
 * poll converges where no poll would not.
 */
let streamHealthy = false;

export function setStreamHealthy(healthy: boolean): void {
  streamHealthy = healthy;
}

export function isStreamHealthy(): boolean {
  return streamHealthy;
}
