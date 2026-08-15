/**
 * In-process document-change bus — the self-host replacement for Firestore
 * trigger delivery. The firestore shim emits a DocChange after every write;
 * the trigger shim subscribes and dispatches to registered handlers.
 *
 * Dispatch is deferred and sequential: changes queue up and run on drain(),
 * so handler cascades (trigger writes doc → next trigger) behave like
 * Firestore's async trigger delivery but stay deterministic in tests.
 */

export interface DocChange {
  collectionPath: string;
  id: string;
  path: string;
  before: Record<string, unknown> | undefined;
  after: Record<string, unknown> | undefined;
}

type Listener = (change: DocChange) => Promise<void>;

const queue: DocChange[] = [];
const listeners: Listener[] = [];
let draining = false;
let autoDrain = false;

/**
 * Production mode: schedule a drain after every emit. Nothing else drains the
 * queue in a deployed host — tests drive drainChanges() explicitly, but a
 * server that never drains delivers NO trigger at all: extraction, matching
 * cascades and invoicing hooks all queue in memory forever. The selfhost
 * server enables this at boot; tests leave it off and keep deterministic
 * manual drains.
 */
export function enableAutoDrain(): void {
  autoDrain = true;
}

export function emitChange(change: DocChange): void {
  queue.push(change);
  if (autoDrain && !draining) {
    // setImmediate, not inline: the write that emitted this change should
    // commit and answer its caller before handlers run, like Firestore's
    // async trigger delivery. drainChanges() is re-entrancy-guarded and
    // loops until quiet, so overlapping schedules collapse to no-ops.
    setImmediate(() => {
      void drainChanges().catch((err) => {
        console.error("selfhost bus: auto-drain failed:", err);
      });
    });
  }
}

export function onChange(listener: Listener): void {
  listeners.push(listener);
}

/**
 * Process queued changes (including ones enqueued by handlers) until quiet.
 * Guard against runaway trigger loops with an iteration cap.
 */
export async function drainChanges(maxIterations = 500): Promise<void> {
  if (draining) return; // re-entrant drain from inside a handler: outer loop finishes the queue
  draining = true;
  try {
    let n = 0;
    while (queue.length > 0) {
      if (++n > maxIterations) {
        throw new Error(`selfhost bus: drain exceeded ${maxIterations} iterations — trigger loop?`);
      }
      const change = queue.shift()!;
      for (const listener of listeners) {
        await listener(change);
      }
    }
  } finally {
    draining = false;
  }
}

export function resetBus(): void {
  queue.length = 0;
}
