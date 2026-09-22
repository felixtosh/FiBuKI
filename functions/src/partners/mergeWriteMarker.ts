/**
 * The marker a Partner Merge stamps on every Partner document it writes, and
 * the single test `onPartnerUpdate` uses to recognise one (#306).
 *
 * A Merge writes both sides: the survivor gains the losers' identifying data,
 * each loser becomes a Merged Partner. Both writes land on `partners`, so both
 * fire `onPartnerUpdate` — whose job, re-running file matching over up to 200
 * files whenever identifying data changes, is exactly what a Merge must not do
 * (#262, [ADR-0005](docs/adr/0005-partner-merge-is-one-way.md)). The trigger
 * therefore has to tell a merge-caused write from a manual alias edit.
 *
 * It tells them apart from the write itself, not from what the write happens to
 * contain. The loser side used to be recognised by `mergedInto` appearing — a
 * field only a loser ever gets — which is why the survivor side was missed
 * entirely and every merge silently paid for a 200-file rematch. One marker,
 * put on every Partner document the Merge touches, means a future writer cannot
 * guard one side and miss the other.
 *
 * A fresh id per Merge rather than a flag, because the trigger compares before
 * against after: a write carrying the id the document already held is somebody
 * else's write, so hand-editing an alias on a Partner that was merged into once
 * still rematches.
 */

import { randomUUID } from "crypto";

/** Field name, stored on `Partner.mergeWriteId`. */
export const MERGE_WRITE_ID_FIELD = "mergeWriteId";

/** One id per Merge operation, shared by every Partner write that merge makes. */
export function newMergeWriteId(): string {
  return randomUUID();
}

/** Mark a pending Partner update as belonging to a Merge. */
export function stampMergeWrite(
  updates: Record<string, unknown>,
  mergeWriteId: string
): void {
  updates[MERGE_WRITE_ID_FIELD] = mergeWriteId;
}

/**
 * True when THIS write is a Merge's own, survivor side or loser side alike:
 * the document came out of it carrying a merge id it did not go in with.
 */
export function isMergeWrite(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): boolean {
  const stamped = after?.[MERGE_WRITE_ID_FIELD];
  if (typeof stamped !== "string" || stamped === "") return false;
  return stamped !== before?.[MERGE_WRITE_ID_FIELD];
}
