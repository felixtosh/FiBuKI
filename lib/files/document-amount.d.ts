export interface DocumentAmountInput {
  extractedAmount?: number | null;
  extractedLineItems?: Array<{ amount: number }> | null;
  lineItemsUnreconciled?: boolean | null;
}

/** The amount a File's document states, in cents (#504). */
export function fileDocumentAmount(file: DocumentAmountInput): number | null;

export interface DocumentVatAmountInput {
  extractedVatAmount?: number | null;
  extractedLineItems?: Array<{ vatAmount: number }> | null;
  lineItemsUnreconciled?: boolean | null;
}

/** The VAT a File's document states, in cents, by the same rule (#504). */
export function fileDocumentVatAmount(file: DocumentVatAmountInput): number | null;
