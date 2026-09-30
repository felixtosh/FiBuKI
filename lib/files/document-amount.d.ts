export interface DocumentAmountInput {
  extractedAmount?: number | null;
  extractedLineItems?: Array<{ amount: number }> | null;
  lineItemsUnreconciled?: boolean | null;
}

/** The amount a File's document states, in cents (#504). */
export function fileDocumentAmount(file: DocumentAmountInput): number | null;
