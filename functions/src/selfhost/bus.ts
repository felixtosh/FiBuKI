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

function scheduleAutoDrain(): void {
  setImmediate(() => {
    void drainChanges().catch((err) => {
      console.error("selfhost bus: auto-drain failed:", err);
    });
  });
}

export function emitChange(change: DocChange): void {
  queue.push(change);
  if (autoDrain && !draining) {
    // setImmediate, not inline: the write that emitted this change should
    // commit and answer its caller before handlers run, like Firestore's
    // async trigger delivery. drainChanges() is re-entrancy-guarded and
    // loops until quiet, so overlapping schedules collapse to no-ops.
    scheduleAutoDrain();
  }
}

export function onChange(listener: Listener): void {
  listeners.push(listener);
}

/**
 * Auto-drain's runaway guard is PER DOCUMENT, not per drain: a real workload
 * legitimately emits thousands of changes in one go (a CSV import writes every
 * transaction, then partner and category matching rewrite most of them; a boot
 * resweep of a few dozen files cascades through extraction → partner match →
 * transaction match → suggestions), while a trigger loop shows up as the SAME
 * path changing without end. Deliberately generous — a file doc is touched a
 * handful of times end to end.
 */
const AUTO_DRAIN_PATH_CAP = 100;
/** Changes seen per path during one continuous busy period; cleared when quiet. */
let busyPathCounts: Map<string, number> | null = null;

function overPathCap(change: DocChange): boolean {
  if (!busyPathCounts) busyPathCounts = new Map();
  const n = (busyPathCounts.get(change.path) ?? 0) + 1;
  busyPathCounts.set(change.path, n);
  return n > AUTO_DRAIN_PATH_CAP;
}

/**
 * Process queued changes (including ones enqueued by handlers) until quiet.
 *
 * `maxIterations` means two different things by mode. Manual (tests): a hard
 * cap — exceeding it throws, keeping runaway-loop tests deterministic. Auto
 * (deployed host): a SLICE — after this many changes the drain yields to the
 * event loop and reschedules itself, so a long cascade neither starves request
 * handling nor gets abandoned. Before this the deployed host threw at 500 and
 * left the rest of the queue stranded until some unrelated write happened to
 * schedule the next drain: "drain exceeded 500 iterations — trigger loop?" on
 * a boot resweep that was not a loop at all.
 */
export async function drainChanges(maxIterations = 500): Promise<void> {
  if (draining) return; // re-entrant drain from inside a handler: outer loop finishes the queue
  draining = true;
  try {
    let n = 0;
    while (queue.length > 0) {
      if (++n > maxIterations) {
        if (!autoDrain) {
          throw new Error(`selfhost bus: drain exceeded ${maxIterations} iterations — trigger loop?`);
        }
        console.log(`selfhost bus: drained ${maxIterations} changes, ${queue.length} still queued — continuing`);
        scheduleAutoDrain();
        return;
      }
      const change = queue.shift()!;
      if (autoDrain && overPathCap(change)) {
        console.error(
          `selfhost bus: ${change.path} changed more than ${AUTO_DRAIN_PATH_CAP} times without the queue going quiet — trigger loop? Dropping this change.`,
        );
        continue;
      }
      for (const listener of listeners) {
        await listener(change);
      }
    }
    busyPathCounts = null;
  } finally {
    draining = false;
  }
}

export function resetBus(): void {
  queue.length = 0;
  busyPathCounts = null;
}
