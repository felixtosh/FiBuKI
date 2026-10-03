/**
 * Invoice Correction views the getCorrection callable returns (#564),
 * frontend copy. Mirrors functions/src/corrections/correctionOps.ts by hand:
 * functions' tsconfig pins `rootDir: "src"`, so neither tree imports the other.
 */

export interface CorrectionTransactionRef {
  id: string;
  date: string | null;
  amount: number;
  partner: string | null;
}

export interface CorrectionFileRef {
  fileId: string;
  fileName: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  date: string | null;
}

export interface CorrectionFileView {
  fileId: string;
  kind: "invoice-correction" | "self-billed-invoice" | null;
  signalsDisagree: boolean;
  referencedInvoiceNumber: string | null;
  link: {
    originalFileId: string;
    setBy: "auto" | "suggested-accepted" | "manual" | "issued-correction";
  } | null;
  original: {
    fileId: string;
    fileName: string | null;
    invoiceNumber: string | null;
    amount: number | null;
    paidBy: CorrectionTransactionRef[];
  } | null;
  suggestions: CorrectionFileRef[];
  candidates: CorrectionFileRef[];
  correctedBy: Array<{ fileId: string; fileName: string | null; transactions: CorrectionTransactionRef[] }>;
}

export interface CorrectionTransactionView {
  transactionId: string;
  related: Array<CorrectionTransactionRef & { relation: "refund-of" | "refunded-by"; viaFileId: string }>;
}
