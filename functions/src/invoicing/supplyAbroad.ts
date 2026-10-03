/**
 * "Service, place of supply abroad (§ 3a Abs 6)" on a FiBuKI Invoice (#565).
 *
 * A B2B service is supplied where the customer is established, so a service
 * to a business abroad is not taxable in Austria. The setting says so on the
 * invoice and records it for the UVA: the Invoice's File carries the kind, and
 * the adapter reads it before any detection.
 *
 * What the setting requires (§ 11 UStG):
 *  - no Austrian VAT on any line (§ 11 Abs 12: VAT printed is VAT owed)
 *  - a customer outside Austria
 *  - an EU customer's UID, printed with the issuer's and the reverse-charge
 *    note (§ 11 Abs 1a)
 *
 * The invoice document is German; the note is printed in German and English,
 * so a customer abroad reads it too.
 */

import { customerCountry, serviceRegionOf } from "../uva/adapter";
import type { Invoice, InvoiceLineItem, InvoiceRecipientSnapshot } from "./types";

export type InvoiceSupplyKind = "service-eu" | "service-non-eu";

/** EU or non-EU, from the recipient's UID prefix first and address country second. */
export function recipientServiceRegion(
  recipient: Pick<InvoiceRecipientSnapshot, "vatId" | "address"> | undefined
): "eu" | "non-eu" | null {
  return serviceRegionOf(recipient?.vatId, recipient?.address?.country);
}

/** The kind an Invoice issued with the setting records; null without it. */
export function invoiceSupplyKind(
  invoice: Pick<Invoice, "supplyAbroad" | "recipient">
): InvoiceSupplyKind | null {
  if (!invoice.supplyAbroad) return null;
  const region = recipientServiceRegion(invoice.recipient);
  if (region === "eu") return "service-eu";
  if (region === "non-eu") return "service-non-eu";
  return null;
}

/** Every line at 0%: the setting forbids Austrian VAT on the invoice. */
export function withoutVat<T extends Pick<InvoiceLineItem, "vatRate">>(lines: T[]): T[] {
  return lines.map((li) => ({ ...li, vatRate: 0 }));
}

/**
 * Why an Invoice with the setting cannot be issued, or null when it can. The
 * recipient may still be blank on a draft, so this is checked at issue.
 */
export function supplyAbroadIssueProblem(
  invoice: Pick<Invoice, "supplyAbroad" | "recipient" | "lineItems"> & {
    issuer?: Pick<Invoice["issuer"], "vatId">;
  }
): string | null {
  if (!invoice.supplyAbroad) return null;
  const country = customerCountry(invoice.recipient?.vatId, invoice.recipient?.address?.country);
  if (!country) {
    return "A service supplied abroad needs the customer's country or UID on the recipient";
  }
  if (country === "AT") {
    return "A service to a customer in Austria is not supplied abroad; clear the setting or change the recipient";
  }
  if (recipientServiceRegion(invoice.recipient) === "eu" && !invoice.recipient?.vatId?.trim()) {
    return "A service to an EU business needs the customer's UID on the invoice (§ 11 Abs 1a UStG)";
  }
  if (recipientServiceRegion(invoice.recipient) === "eu" && invoice.issuer && !invoice.issuer.vatId?.trim()) {
    return "A service to an EU business needs your own UID on the invoice (§ 11 Abs 1a UStG)";
  }
  if (invoice.lineItems.some((li) => li.vatRate !== 0)) {
    return "A service supplied abroad carries no Austrian VAT; every line must be at 0%";
  }
  return null;
}

/** The note the invoice prints, German line first (#565). */
export function supplyAbroadNote(kind: InvoiceSupplyKind): { de: string; en: string } {
  return kind === "service-eu"
    ? {
        de: "Steuerschuldnerschaft des Leistungsempfängers.",
        en: "Reverse charge: VAT to be accounted for by the recipient.",
      }
    : {
        de: "Nicht im Inland steuerbare Leistung.",
        en: "Not taxable in Austria.",
      };
}
