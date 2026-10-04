/**
 * The Receipt Link view the getReceiptLink callable returns (#571,
 * ADR-0012), frontend copy. Mirrors functions/src/receiptPairs/receiptPairOps.ts
 * by hand: functions' tsconfig pins `rootDir: "src"`, so neither tree imports
 * the other's types.
 */

export type ReceiptLinkSetBy = "auto" | "suggested-accepted" | "manual";

export interface ReceiptPairFileRef {
  fileId: string;
  fileName: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  transactionIds: string[];
}

export interface ReceiptLinkView {
  fileId: string;
  /** The invoice number this File cites as paid. */
  paidInvoiceNumber: string | null;
  /** The invoice this File is the Receipt of. */
  link: { invoiceFileId: string; setBy: ReceiptLinkSetBy } | null;
  invoice: ReceiptPairFileRef | null;
  /** The Receipts linked to this File, when it is an invoice. */
  receipts: Array<ReceiptPairFileRef & { setBy: ReceiptLinkSetBy }>;
  /** Suggested pairs; `suggestedReceiptId` is null when the person picks the Receipt. */
  suggestions: Array<ReceiptPairFileRef & { suggestedReceiptId: string | null }>;
  /** Files this one may be linked to as its invoice; only with `withCandidates`. */
  candidates: ReceiptPairFileRef[];
}
