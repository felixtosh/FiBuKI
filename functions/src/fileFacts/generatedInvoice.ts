/**
 * A generated invoice's facts, as the File facts module writes them (#640).
 *
 * FiBuKI wrote the document, so nothing is read off it: the File's facts are
 * the invoice's own. A draft's stub carries only its direction (the User is
 * the issuer); issuing or regenerating the PDF writes the issued invoice's
 * figures and parties.
 *
 * No derived field is computed here, the same as before #640: a generated
 * invoice has never carried a Document Type, a review flag or a Due Date of
 * its own, and changing that is a decision of its own, not a side effect of
 * moving the writer. The Hand Correction record is not touched either: the
 * invoice is the document, and a re-issue writes what it prints.
 */

import { computeLineItemTotals, type Invoice, type InvoicePartnerAddress } from "../invoicing/types";

/** The facts of a draft's stub, before any PDF exists. */
export function draftInvoiceFacts(): Record<string, unknown> {
  return {
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
  };
}

/** The facts of an issued invoice's File: what its PDF prints. */
export function issuedInvoiceFacts(invoice: Invoice): Record<string, unknown> {
  // The invoice's own line items keep quantity and unit price; the extracted
  // shape they are projected into is four fields (#252). The cents come from
  // the same arithmetic as the printed totals, so the lines sum to them and an
  // Invoice Correction's lines are exactly its original's, negated.
  const extractedLineItems = invoice.lineItems.map((li) => {
    const { vatCents, grossCents } = computeLineItemTotals(li);
    return {
      description: li.description,
      vatPercent: li.vatRate,
      vatAmount: vatCents,
      amount: grossCents,
    };
  });

  const uniqueVatRates = Array.from(new Set(invoice.lineItems.map((li) => li.vatRate)));
  const singleVatRate = uniqueVatRates.length === 1 ? uniqueVatRates[0] : null;

  const recipientAddressLine = formatAddressOneLine(invoice.recipient.address);

  return {
    ...draftInvoiceFacts(),
    extractedDate: invoice.issueDate,
    extractedAmount: invoice.total,
    extractedCurrency: invoice.currency,
    extractedVatAmount: invoice.vatAmount,
    extractedVatPercent: singleVatRate,
    extractedPartner: invoice.recipient.name,
    extractedIban: invoice.issuer.iban,
    extractedLineItems,
    extractedIssuer: {
      name: invoice.issuer.name,
      vatId: invoice.issuer.vatId || null,
      address: formatAddressOneLine(invoice.issuer.address) || null,
      iban: invoice.issuer.iban,
      website: null,
    },
    extractedRecipient: {
      name: invoice.recipient.name,
      vatId: invoice.recipient.vatId || null,
      address: recipientAddressLine || null,
      iban: null,
      website: null,
    },
    extractedVatId: invoice.recipient.vatId || null,
    extractedAddress: recipientAddressLine || null,
  };
}

function formatAddressOneLine(addr?: InvoicePartnerAddress): string | undefined {
  if (!addr) return undefined;
  const parts: string[] = [];
  if (addr.street) parts.push(addr.street);
  const postalCity = [addr.postalCode, addr.city].filter(Boolean).join(" ");
  if (postalCity) parts.push(postalCity);
  if (addr.country) parts.push(addr.country);
  return parts.length > 0 ? parts.join(", ") : undefined;
}
