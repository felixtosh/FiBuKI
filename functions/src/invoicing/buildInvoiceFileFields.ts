/**
 * Shared helper used by issueInvoice + regenerateInvoicePdf to produce the
 * TaxFile field set for a Fibuki-generated invoice file. Keeps the two
 * paths in lockstep so post-issue edits stay reflected on the file record
 * (fileName, extractedAmount, line items, etc.).
 *
 * `draftFileStubFields` is the other end: the TaxFile a draft carries before
 * any PDF exists, written by createInvoice and restored by undoIssueInvoice.
 */

import { Timestamp } from "firebase-admin/firestore";
import { Invoice, InvoicePartnerAddress, computeLineItemTotals } from "./types";
import { invoiceSupplyKind } from "./supplyAbroad";

function formatAddressOneLine(
  addr?: InvoicePartnerAddress,
): string | undefined {
  if (!addr) return undefined;
  const parts: string[] = [];
  if (addr.street) parts.push(addr.street);
  const postalCity = [addr.postalCode, addr.city].filter(Boolean).join(" ");
  if (postalCity) parts.push(postalCity);
  if (addr.country) parts.push(addr.country);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** The placeholder number a draft shows until it is issued. */
export function draftPlaceholderNumber(): string {
  return `DRAFT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

/**
 * The stub TaxFile of a draft invoice. The PDF does not exist yet
 * (storagePath/downloadUrl empty); issueInvoice fills this same doc in place.
 *
 * extractionComplete=true + isFibukiGenerated=true short-circuits the
 * extractFileData onCreate trigger (see functions/src/extraction/extractFileData.ts).
 */
export function draftFileStubFields(invoiceId: string): Record<string, unknown> {
  return {
    fileName: "Rechnungsentwurf",
    fileType: "application/pdf",
    fileSize: 0,
    storagePath: "",
    downloadUrl: "",
    extractionComplete: true,
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    sourceType: "fibuki_invoice",
    invoiceId,
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
  };
}

interface BuildOptions {
  storagePath: string;
  downloadUrl: string;
  fileSize: number;
}

export function buildInvoiceFileFields(
  invoice: Invoice,
  opts: BuildOptions,
): Record<string, unknown> {
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

  const uniqueVatRates = Array.from(
    new Set(invoice.lineItems.map((li) => li.vatRate)),
  );
  const singleVatRate = uniqueVatRates.length === 1 ? uniqueVatRates[0] : null;

  const recipientAddressLine = formatAddressOneLine(invoice.recipient.address);

  const fields: Record<string, unknown> = {
    fileName: `${invoice.number}.pdf`,
    fileType: "application/pdf",
    fileSize: opts.fileSize,
    storagePath: opts.storagePath,
    downloadUrl: opts.downloadUrl,
    classificationComplete: true,
    isNotInvoice: false,
    isFibukiGenerated: true,
    invoiceId: invoice.id,
    invoiceDirection: "outgoing",
    matchedUserAccount: "issuer",
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
    // What the UVA reads before any detection (#565). Null clears it when the
    // setting is turned off and the PDF regenerated.
    invoiceSupplyKind: invoiceSupplyKind(invoice),
    updatedAt: Timestamp.now(),
  };

  return fields;
}
