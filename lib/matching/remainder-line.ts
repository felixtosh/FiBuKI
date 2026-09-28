/**
 * What a Transaction's Remainder line shows (#246).
 *
 * It used to disappear while any connected File was still being extracted,
 * and the obvious fix, counting such a File as 0,00, makes a freshly uploaded
 * File turn a documented Transaction wholly open. Instead a File still being
 * read is left out of the sum and named: "1 File still being read". The split
 * itself is `summarizeConnectedFiles`, the helper the scorers read too.
 */

import {
  deriveCoverage,
  summarizeConnectedFiles,
  type ConnectedFileAmount,
} from "@/functions/src/matching/coverage";

export interface RemainderLineFile extends ConnectedFileAmount {
  /** The payment total could not be converted into the Transaction's currency. */
  conversionFailed?: boolean;
}

export type RemainderLineState =
  /** No File has anything to count and none is being read. */
  | { kind: "hidden" }
  /** Every File is still being read: nothing to subtract yet. */
  | { kind: "pending"; pendingCount: number }
  /** Some finished File has no usable amount. */
  | { kind: "missing"; pendingCount: number }
  /** The Remainder over the Files that could be counted. */
  | { kind: "figure"; remainder: number; pendingCount: number };

export function remainderLineState(
  transactionAmount: number,
  files: RemainderLineFile[]
): RemainderLineState {
  const { documentedAmount, pendingCount } = summarizeConnectedFiles(files);
  const counted = files.filter((f) => !(f.extractionPending && f.payment == null));

  if (counted.length === 0) {
    return pendingCount > 0 ? { kind: "pending", pendingCount } : { kind: "hidden" };
  }
  if (counted.every((f) => f.payment == null) && pendingCount === 0) {
    return { kind: "hidden" };
  }
  if (counted.some((f) => f.payment == null || f.conversionFailed)) {
    return { kind: "missing", pendingCount };
  }
  const { remainder } = deriveCoverage(transactionAmount, documentedAmount);
  return { kind: "figure", remainder, pendingCount };
}

/** "1 File still being read", "2 Files still being read". */
export function pendingFilesLabel(count: number): string {
  return `${count} File${count === 1 ? "" : "s"} still being read`;
}
