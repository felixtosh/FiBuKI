/**
 * Which mail a Sync fetches (#103).
 *
 * The bulk pull over a user's whole transaction span was too expensive, so no
 * Sync reaches back into history any more: a first Sync covers today only,
 * and every later one (scheduled, manual) runs forward from where the last
 * stopped. Receipts for older Transactions are found by per-Transaction mail
 * search (precision-search/queueIncompleteSearch.ts), which the finished first
 * Sync and every Import queue.
 *
 * No `firebase-functions` import: the web container's manual-sync route uses
 * this too.
 */

export interface SyncRange {
  from: Date;
  to: Date;
}

/** Days of mail the first Sync of a newly connected mailbox pulls. */
export const FIRST_SYNC_WINDOW_DAYS = 0;

/** The first Sync's window: the start of the day FIRST_SYNC_WINDOW_DAYS back, to now. */
export function firstSyncWindow(now: Date = new Date()): { dateFrom: Date; dateTo: Date } {
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  dateFrom.setDate(dateFrom.getDate() - FIRST_SYNC_WINDOW_DAYS);
  return { dateFrom, dateTo: now };
}

/**
 * The mail a later Sync still has to fetch: from just after the synced range
 * to now, or from the start of today when nothing was synced yet. Empty when
 * the synced range already reaches now.
 */
export function forwardSyncGaps(syncedRange: SyncRange | null, now: Date = new Date()): SyncRange[] {
  const from = syncedRange
    ? new Date(syncedRange.to.getTime() + 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return from < now ? [{ from, to: now }] : [];
}
