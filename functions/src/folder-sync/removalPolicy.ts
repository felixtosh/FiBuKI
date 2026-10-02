/**
 * What a Folder Integration does with a File whose original disappeared from
 * the folder (ADR-0009). Pure: file state, integration settings and the size
 * of the run in; one decision per File out. No I/O, so every rule is a test.
 */

export type GoneDecision =
  /** Leave the File alone (still in the folder, or already handled). */
  | "none"
  /** Mark it "no longer in the folder" and keep it. */
  | "mark"
  /** Reversible delete (ADR-0006), never a Purge. */
  | "delete";

export interface GoneFileState {
  /** The File is connected to at least one Transaction. */
  connected: boolean;
  /** Already deleted in FiBuKI. */
  deleted: boolean;
  /** Already marked gone at source. */
  alreadyMarkedGone: boolean;
}

export interface FolderSyncSettings {
  /** "Also delete Files that are connected to a Transaction" (off by default). */
  removeConnectedFiles: boolean;
}

/** One File's fate once its original is gone. */
export function decideGoneFile(
  file: GoneFileState,
  settings: FolderSyncSettings,
): GoneDecision {
  if (file.deleted) return "none";
  if (!file.connected || settings.removeConnectedFiles) return "delete";
  return file.alreadyMarkedGone ? "none" : "mark";
}

/** Hard floor and ceiling of the circuit breaker. */
export const BREAKER_MIN = 3;
export const BREAKER_MAX = 10;
export const BREAKER_RATIO = 0.25;

/**
 * How many removals one run may carry out: 25 % of the Files the integration
 * has imported, but never more than 10 and never fewer than 3 (a folder of
 * four files may lose three).
 */
export function removalLimit(importedCount: number): number {
  const byRatio = Math.floor(importedCount * BREAKER_RATIO);
  return Math.max(BREAKER_MIN, Math.min(BREAKER_MAX, byRatio));
}

/**
 * The breaker. A renamed, unshared or emptied folder looks exactly like
 * "everything was deleted", so a run that would remove more than the limit
 * removes nothing. Marking is not removal and is never counted.
 */
export function breakerTripped(removals: number, importedCount: number): boolean {
  return removals > removalLimit(importedCount);
}
