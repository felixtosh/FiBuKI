/**
 * Shared helper used by issueInvoice + regenerateInvoicePdf to produce the
 * TaxFile field set for a Fibuki-generated invoice file. Keeps the two
 * paths in lockstep so post-issue edits stay reflected on the file record
 * (fileName, extractedAmount, line items, etc.).
 */

import { Timestamp } from "firebase-admin/firestore";
import { Invoice, InvoicePartnerAddress } from "./types";

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

interface BuildOptions {
  storagePath: string;
  downloadUrl: string;
  fileSize: number;
}

export function buildInvoiceFileFields(
  invoice: Invoice,
  opts: BuildOptions,
): Record<string, unknown> {
  const extractedLineItems = invoice.lineItems.map((li) => ({
    description: li.description,
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    vatPercent: li.vatRate,
    vatAmount: Math.round((li.quantity * li.unitPrice * li.vatRate) / 100),
    amount: Math.round(li.quantity * li.unitPrice * (1 + li.vatRate / 100)),
  }));

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
    updatedAt: Timestamp.now(),
  };

  return fields;
}
