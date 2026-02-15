/**
 * Worker Queue Scheduler — pure scheduling logic with no React/Firebase deps.
 *
 * Manages a queue of worker requests with:
 * - Configurable max concurrency
 * - Partner-level locking (prevents concurrent same-partner runs)
 * - Dedup + cancelled-id tracking
 */

export interface SchedulerRequest {
  id: string;
  workerType: string;
  triggerContext?: { partnerId?: string };
  notBeforeAt?: { toMillis?: () => number; seconds?: number; nanoseconds?: number } | null;
}

export interface SchedulerCallbacks<T extends SchedulerRequest> {
  onDispatch: (request: T) => Promise<void>;
  onCancel: (request: T) => void;
  onStateChange: (state: {
    pendingCount: number;
    activeCount: number;
    isProcessing: boolean;
  }) => void;
}

export class WorkerQueueScheduler<T extends SchedulerRequest> {
  private queue: T[] = [];
  private activePartnerIds = new Set<string>();
  private activeCount = 0;
  private cancelledIds = new Set<string>();
  private readonly maxConcurrent: number;
  private readonly callbacks: SchedulerCallbacks<T>;

  constructor(maxConcurrent: number, callbacks: SchedulerCallbacks<T>) {
    this.maxConcurrent = maxConcurrent;
    this.callbacks = callbacks;
  }

  // --- Public API ---

  /** Add new requests to the queue (dedup by id, filter cancelled). */
  enqueue(requests: T[]): void {
    let changed = false;
    const existingIndexById = new Map(this.queue.map((r, idx) => [r.id, idx]));

    for (const request of requests) {
      if (this.cancelledIds.has(request.id)) continue;

      const existingIndex = existingIndexById.get(request.id);
      if (existingIndex === undefined) {
        this.queue.push(request);
        existingIndexById.set(request.id, this.queue.length - 1);
      } else {
        this.queue[existingIndex] = request;
      }
      changed = true;
    }

    if (changed) {
      this.notifyState();
    }
  }

  /** Dispatch eligible requests up to maxConcurrent. */
  dispatch(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const pick = this.pickNextRequest();
      if (!pick) break; // all remaining blocked by active partners

      const { request, index } = pick;
      this.queue.splice(index, 1);

      const partnerId = request.triggerContext?.partnerId;
      if (partnerId) this.activePartnerIds.add(partnerId);
      this.activeCount++;

      // Fire-and-forget — completion triggers re-dispatch via onWorkerDone
      this.callbacks
        .onDispatch(request)
        .finally(() => this.onWorkerDone(request));
    }

    this.notifyState();
  }

  /** Cancel all pending requests for a specific partner. */
  cancelPendingForPartner(partnerId: string): void {
    this.queue = this.queue.filter((r) => {
      if (r.triggerContext?.partnerId === partnerId) {
        this.cancelledIds.add(r.id);
        this.callbacks.onCancel(r);
        return false;
      }
      return true;
    });
    this.notifyState();
  }

  // --- Read-only accessors (useful for testing) ---

  get pendingCount(): number {
    return this.queue.length;
  }

  get activeWorkerCount(): number {
    return this.activeCount;
  }

  get isProcessing(): boolean {
    return this.activeCount > 0 || this.queue.length > 0;
  }

  get queueSnapshot(): readonly T[] {
    return this.queue;
  }

  get cancelledIdSet(): ReadonlySet<string> {
    return this.cancelledIds;
  }

  // --- Private ---

  private pickNextRequest(): { request: T; index: number } | null {
    const nowMs = Date.now();
    for (let i = 0; i < this.queue.length; i++) {
      const request = this.queue[i];
      const notBeforeMs = this.getNotBeforeMillis(request.notBeforeAt);
      if (notBeforeMs !== null && notBeforeMs > nowMs) {
        continue;
      }

      const partnerId = request.triggerContext?.partnerId;
      if (!partnerId || !this.activePartnerIds.has(partnerId)) {
        return { request, index: i };
      }
    }
    return null;
  }

  private getNotBeforeMillis(
    notBeforeAt: SchedulerRequest["notBeforeAt"]
  ): number | null {
    if (!notBeforeAt) return null;
    if (typeof notBeforeAt.toMillis === "function") {
      return notBeforeAt.toMillis();
    }
    if (typeof notBeforeAt.seconds === "number") {
      return notBeforeAt.seconds * 1000 + Math.floor((notBeforeAt.nanoseconds || 0) / 1_000_000);
    }
    return null;
  }

  private onWorkerDone(request: T): void {
    const partnerId = request.triggerContext?.partnerId;
    if (partnerId) this.activePartnerIds.delete(partnerId);
    this.activeCount--;

    // Do not auto-cancel partner batch siblings here.
    // partnerBatchStates state machine handles coalescing/reruns and decides what to run next.

    // Try to fill freed slot(s)
    this.dispatch();
  }

  private notifyState(): void {
    this.callbacks.onStateChange({
      pendingCount: this.queue.length,
      activeCount: this.activeCount,
      isProcessing: this.activeCount > 0 || this.queue.length > 0,
    });
  }
}
