/**
 * How many File Connections a row in a connect overlay already carries,
 * counting only the ones to something other than the item in hand.
 *
 * Both connect overlays badge their rows with this (#241, #243): a File row
 * with the Transactions it already documents, a Transaction row with the Files
 * already on it. The item in hand is left out because a row connected to it
 * keeps its own "Connected" treatment, and counting that Connection too would
 * make every connected row read "1 Transaction" as well.
 *
 * A count, never a verdict: a File legitimately sits on two Transactions in a
 * split payment, and a Transaction holding a File is exactly where a second
 * part-invoice lands. Nothing is hidden or disabled because of it.
 */
export function otherConnectionCount(
  connectedIds: readonly string[] | null | undefined,
  inHandId?: string | null
): number {
  if (!connectedIds || connectedIds.length === 0) return 0;
  const distinct = new Set(connectedIds);
  if (inHandId) distinct.delete(inHandId);
  return distinct.size;
}

/** "1 Transaction", "2 Transactions", "1 File", ... */
export function connectionCountLabel(
  count: number,
  noun: "Transaction" | "File"
): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * May this File be offered in the overlay that finds a File for a Transaction?
 *
 * Files already connected to a Transaction are offered too (#241): they used
 * to be filtered out here, which hid the second half of every split payment.
 * They now appear with their Connection count instead. A File marked as not an
 * invoice stays out, as before.
 */
export function isConnectCandidateFile(file: {
  isNotInvoice?: boolean | null;
}): boolean {
  return !file.isNotInvoice;
}
