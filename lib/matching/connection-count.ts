import {
  deriveCoverage,
  filePaymentTotal,
  summarizeConnectedFiles,
  type Coverage,
} from "@/functions/src/matching/coverage";

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

/**
 * The Remainder a Transaction row in the connect overlay prints (#243), or
 * null when it prints none.
 *
 * Printed only when the pair is scored against the Remainder at all (some
 * connected File explains part of the line and something is still open) and
 * the Transaction is not yet documented (Coverage below COVERAGE_RATIO). A
 * fully documented Transaction shows its File badge and no figure.
 *
 * Takes the Coverage the scorer returned with the Match. Only for a
 * Transaction the scorer did not return is it derived here, and then through
 * the same `deriveCoverage` the scorer uses, never a second subtraction.
 */
export function rowRemainder(
  coverage: Pick<Coverage, "remainder" | "isCovered" | "againstRemainder"> | null | undefined
): number | null {
  if (!coverage) return null;
  if (!coverage.againstRemainder || coverage.isCovered) return null;
  return coverage.remainder;
}

/**
 * Coverage for a Transaction the scorer did not return, from the payment
 * totals of the Files connected to it (the File being matched left out, as the
 * scorer leaves it out). Null when those Files explain nothing.
 */
export function coverageFromConnectedFiles(
  transactionAmount: number,
  connectedFiles: Array<{
    id?: string;
    extractedAmount?: number | null;
    extractedTipAmount?: number | null;
    extractedCurrency?: string | null;
    receiptLink?: { fileId?: string | null } | null;
  }>
): Coverage | null {
  // Through the summary the scorer reads, so a Receipt beside the invoice it
  // pays counts once here as well (#571).
  const documented = summarizeConnectedFiles(
    connectedFiles.map((f) => ({
      payment: filePaymentTotal(f.extractedAmount, f.extractedTipAmount),
      extractionPending: false,
      fileId: f.id,
      currency: f.extractedCurrency ?? null,
      receiptOfFileId: f.receiptLink?.fileId ?? null,
    }))
  ).documentedAmount;
  if (documented <= 0) return null;
  return deriveCoverage(transactionAmount, documented);
}
