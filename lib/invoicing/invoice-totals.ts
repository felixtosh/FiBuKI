/**
 * Single source of truth for invoice money math on the app (Next) side.
 *
 * The per-line "Summe/Gesamt" column and the invoice totals must agree, and
 * they must agree across all three renderers (in-app PDF preview, public
 * `/i/[token]` HTML view, and the stored server PDF). They previously drifted:
 * the HTML view printed the line GROSS in that column while the PDFs printed
 * the line NET, so the same invoice looked inconsistent depending on where it
 * was viewed.
 *
 * Austrian invoice convention (Kleinunternehmer / EPU): the per-line amount
 * column is NET. USt is summed once, and only the final "Gesamt" is gross:
 *
 *   Zwischensumme (netto) = Σ line net
 *   USt                   = Σ line vat
 *   Gesamt                = Zwischensumme + USt
 *
 * The canonical arithmetic lives in `@/types/invoice` (computeLineItemTotals /
 * computeInvoiceTotals). This module re-exports it and adds the small
 * presentation helpers the renderers need, so there is one import for the app
 * side.
 *
 * NOTE ON THE SERVER PDF: `functions/tsconfig.json` pins `rootDir: "src"`, so
 * the Cloud Functions build cannot import anything under this app-level `lib/`.
 * The server renderer (functions/src/invoicing/invoiceDocument.tsx) therefore
 * uses the byte-identical copy of computeLineItemTotals that already lives in
 * functions/src/invoicing/types.ts. Keep the "line column = net" rule identical
 * in both places if either ever changes.
 */

import {
  InvoiceLineItem,
  computeInvoiceTotals,
  computeLineItemTotals,
} from "@/types/invoice";

export { computeInvoiceTotals, computeLineItemTotals };

/**
 * The value shown in a line item's amount column ("Summe" / "Gesamt").
 * NET per line, per Austrian convention.
 */
export function lineItemColumnCents(item: InvoiceLineItem): number {
  return computeLineItemTotals(item).netCents;
}

/**
 * German cents -> currency string, e.g. 123456 -> "1.234,56 €".
 * Mirrors the formatter embedded in the two @react-pdf renderers.
 */
export function formatMoneyCents(cents: number): string {
  const safe = Math.round(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const euros = Math.floor(abs / 100);
  const remainder = abs % 100;
  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${eurosStr},${String(remainder).padStart(2, "0")} €`;
}
