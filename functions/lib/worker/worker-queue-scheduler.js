"use strict";
/**
 * Worker Queue Scheduler — pure scheduling logic with no React/Firebase deps.
 *
 * Manages a queue of worker requests with:
 * - Configurable max concurrency
 * - Partner-level locking (prevents concurrent same-partner runs)
 * - Dedup + cancelled-id tracking
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerQueueScheduler = void 0;
class WorkerQueueScheduler {
    constructor(maxConcurrent, callbacks) {
        this.queue = [];
        this.activePartnerIds = new Set();
        this.activeCount = 0;
        this.cancelledIds = new Set();
        this.maxConcurrent = maxConcurrent;
        this.callbacks = callbacks;
    }
    // --- Public API ---
    /** Add new requests to the queue (dedup by id, filter cancelled). */
    enqueue(requests) {
        let changed = false;
        const existingIndexById = new Map(this.queue.map((r, idx) => [r.id, idx]));
        for (const request of requests) {
            if (this.cancelledIds.has(request.id))
                continue;
            const existingIndex = existingIndexById.get(request.id);
            if (existingIndex === undefined) {
                this.queue.push(request);
                existingIndexById.set(request.id, this.queue.length - 1);
            }
            else {
                this.queue[existingIndex] = request;
            }
            changed = true;
        }
        if (changed) {
            this.notifyState();
        }
    }
    /** Dispatch eligible requests up to maxConcurrent. */
    dispatch() {
        while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
            const pick = this.pickNextRequest();
            if (!pick)
                break; // all remaining blocked by active partners
            const { request, index } = pick;
            this.queue.splice(index, 1);
            const partnerId = request.triggerContext?.partnerId;
            if (partnerId)
                this.activePartnerIds.add(partnerId);
            this.activeCount++;
            // Fire-and-forget — completion triggers re-dispatch via onWorkerDone
            this.callbacks
                .onDispatch(request)
                .finally(() => this.onWorkerDone(request));
        }
        this.notifyState();
    }
    /** Cancel all pending requests for a specific partner. */
    cancelPendingForPartner(partnerId) {
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
    get pendingCount() {
        return this.queue.length;
    }
    get activeWorkerCount() {
        return this.activeCount;
    }
    get isProcessing() {
        return this.activeCount > 0 || this.queue.length > 0;
    }
    get queueSnapshot() {
        return this.queue;
    }
    get cancelledIdSet() {
        return this.cancelledIds;
    }
    // --- Private ---
    pickNextRequest() {
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
    getNotBeforeMillis(notBeforeAt) {
        if (!notBeforeAt)
            return null;
        if (typeof notBeforeAt.toMillis === "function") {
            return notBeforeAt.toMillis();
        }
        if (typeof notBeforeAt.seconds === "number") {
            return notBeforeAt.seconds * 1000 + Math.floor((notBeforeAt.nanoseconds || 0) / 1000000);
        }
        return null;
    }
    onWorkerDone(request) {
        const partnerId = request.triggerContext?.partnerId;
        if (partnerId)
            this.activePartnerIds.delete(partnerId);
        this.activeCount--;
        // Do not auto-cancel partner batch siblings here.
        // partnerBatchStates state machine handles coalescing/reruns and decides what to run next.
        // Try to fill freed slot(s)
        this.dispatch();
    }
    notifyState() {
        this.callbacks.onStateChange({
            pendingCount: this.queue.length,
            activeCount: this.activeCount,
            isProcessing: this.activeCount > 0 || this.queue.length > 0,
        });
    }
}
exports.WorkerQueueScheduler = WorkerQueueScheduler;
//# sourceMappingURL=worker-queue-scheduler.js.map