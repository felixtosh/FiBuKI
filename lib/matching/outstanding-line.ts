/**
 * What a File's Outstanding line shows (#615, ADR-0013).
 *
 * The figure is `deriveOutstanding`'s, the helper the matcher scores a further
 * payment against, so the panel and the scores cannot disagree. This module
 * only decides which of the line's states that figure is, with the one
 * tolerance (`isRemainderClosed`) that says a gap is closed.
 */

import {
  deriveOutstanding,
  filePaymentTotal,
  isExtractionPending,
  isRemainderClosed,
  type ConnectedFileAmount,
} from "@/functions/src/matching/coverage";

/** The fields of a File the line reads. */
export interface OutstandingLineFile {
  id: string;
  extractedAmount?: number | null;
  extractedTipAmount?: number | null;
  extractedCurrency?: string | null;
  extractionComplete?: boolean | null;
  isNotInvoice?: boolean | null;
  receiptLink?: { fileId?: string | null } | null;
  transactionIds?: string[];
}

/** The fields of a connected Transaction the line reads. */
export interface OutstandingLineTransaction {
  id: string;
  amount: number;
  currency?: string | null;
}

export type OutstandingLineState =
  /** No payment connected, no amount, or a payment in another currency. */
  | { kind: "hidden" }
  /** Part of the File is still unpaid. */
  | { kind: "open"; outstanding: number; total: number }
  /** Paid, within the close tolerance. */
  | { kind: "paid" }
  /** Paid, and the payments came to more than the File by beyond the tolerance. */
  | { kind: "overpaid"; overpaid: number };

function asConnectedFile(file: OutstandingLineFile): ConnectedFileAmount {
  return {
    fileId: file.id,
    payment: filePaymentTotal(file.extractedAmount, file.extractedTipAmount),
    extractionPending: isExtractionPending(file),
    currency: file.extractedCurrency ?? null,
    receiptOfFileId: file.receiptLink?.fileId ?? null,
  };
}

/**
 * The line for `file`, connected to `transactions`. `allFiles` is the User's
 * Files, from which each Transaction's other Files are read: a Transaction
 * that pays other Files too pays this one its share.
 */
export function outstandingLineState(
  file: OutstandingLineFile,
  transactions: OutstandingLineTransaction[],
  allFiles: OutstandingLineFile[]
): OutstandingLineState {
  if (transactions.length === 0) return { kind: "hidden" };
  const self = asConnectedFile(file);
  const result = deriveOutstanding(
    { fileId: file.id, payment: self.payment, currency: self.currency, receiptOfFileId: self.receiptOfFileId },
    transactions.map((tx) => ({
      transactionAmount: tx.amount,
      transactionCurrency: tx.currency,
      files: allFiles.filter((f) => f.transactionIds?.includes(tx.id)).map(asConnectedFile),
    }))
  );
  if (!result) return { kind: "hidden" };
  if (!isRemainderClosed(result.outstanding)) {
    return { kind: "open", outstanding: result.outstanding, total: result.total };
  }
  if (!isRemainderClosed(result.overpaid)) return { kind: "overpaid", overpaid: result.overpaid };
  return { kind: "paid" };
}
