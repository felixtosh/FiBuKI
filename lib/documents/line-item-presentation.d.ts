import type { DocumentTone } from "./document-type-presentation";

export interface LineItemsUnreconciledPresentation {
  label: string;
  tone: DocumentTone;
  /**
   * The VAT rates the reconciliation localised the damage to. Empty while
   * the presentation still applies means the whole document is suspect.
   */
  rates: number[];
  text: string;
}

export declare function describeLineItemsUnreconciled(
  file:
    | {
        lineItemsUnreconciled?: boolean | null;
        lineItemsUnreconciledRates?: number[] | null;
      }
    | null
    | undefined,
): LineItemsUnreconciledPresentation | null;
