import { Timestamp } from "firebase/firestore";
import { PartnerAddress } from "./partner";

export type InvoiceStatus = "draft" | "issued" | "sent" | "paid" | "cancelled";

export interface InvoiceLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
}

export interface InvoiceIssuerSnapshot {
  entityId: string;
  name: string;
  vatId?: string;
  address?: PartnerAddress;
  iban: string;
  bic?: string;
}

export interface InvoiceRecipientSnapshot {
  partnerId: string;
  partnerType: "user" | "global";
  name: string;
  vatId?: string;
  address?: PartnerAddress;
}

export interface Invoice {
  id: string;
  userId: string;

  number: string;
  status: InvoiceStatus;

  /**
   * Optional short user-defined prefix used to compose the display name, e.g.
   * "INV" -> "INV-2026-0007". When absent, the composed name falls back to a
   * 3-letter uppercase abbreviation of the recipient's name.
   */
  namePrefix?: string;
  /**
   * The integer sequence number for this invoice within its
   * (year, namePrefix) bucket. Persisted from draft time so the user can see
   * and edit the upcoming number. Zero-padded to 4 digits at display time.
   */
  numberSeq?: number;

  issuer: InvoiceIssuerSnapshot;
  recipient: InvoiceRecipientSnapshot;

  issueDate: Timestamp;
  paymentTerms: string;
  dueDate: Timestamp;

  lineItems: InvoiceLineItem[];
  notes?: string;
  currency: string;

  subtotal: number;
  vatAmount: number;
  total: number;

  fileId?: string;
  shareToken?: string;
  shareTokenCreatedAt?: Timestamp;

  issuedAt?: Timestamp;
  sentAt?: Timestamp;
  sentVia?: "gmail_draft" | "gmail_sent" | "manual";
  paidByTransactionId?: string;
  paidAt?: Timestamp;
  cancelledAt?: Timestamp;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface InvoiceShare {
  token: string;
  invoiceId: string;
  userId: string;
  createdAt: Timestamp;
  revokedAt?: Timestamp;
  accessCount: number;
  lastAccessedAt?: Timestamp;
}

export interface InvoiceFormData {
  partnerId: string;
  partnerType: "user" | "global";
  issuerEntityId: string;
  issuerIban: string;
  issueDate: Date;
  paymentTerms: string;
  dueDate?: Date;
  lineItems: Array<Omit<InvoiceLineItem, "id"> & { id?: string }>;
  notes?: string;
  currency?: string;
}

export const DEFAULT_PAYMENT_TERMS = "Zahlbar innerhalb von 14 Tagen";
export const DEFAULT_CURRENCY = "EUR";
export const DEFAULT_VAT_RATE = 20;

export function computeLineItemTotals(item: InvoiceLineItem): {
  netCents: number;
  vatCents: number;
  grossCents: number;
} {
  const netCents = Math.round(item.quantity * item.unitPrice);
  const vatCents = Math.round((netCents * item.vatRate) / 100);
  return { netCents, vatCents, grossCents: netCents + vatCents };
}

export function computeInvoiceTotals(lineItems: InvoiceLineItem[]): {
  subtotal: number;
  vatAmount: number;
  total: number;
} {
  let subtotal = 0;
  let vatAmount = 0;
  for (const item of lineItems) {
    const { netCents, vatCents } = computeLineItemTotals(item);
    subtotal += netCents;
    vatAmount += vatCents;
  }
  return { subtotal, vatAmount, total: subtotal + vatAmount };
}

/**
 * Build a 3-letter uppercase abbreviation from a recipient name. Strips
 * non-letter characters (so "P.H. Häusler" -> "PHH") and pads with "X" if the
 * name is shorter than 3 alphabetic characters.
 */
export function partnerAbbrev(name?: string): string {
  if (!name) return "XXX";
  const letters = name.replace(/[^A-Za-zÄÖÜäöüß]/g, "");
  const upper = letters.toUpperCase();
  if (upper.length === 0) return "XXX";
  return upper.slice(0, 3).padEnd(3, "X");
}

/**
 * Compose the human-readable invoice name from its parts. The shape is:
 *   {namePrefix || partnerAbbrev(recipient)}-{year}-{padded numberSeq}
 *
 * Falls back to "(Entwurf)" when there's no year or sequence yet.
 */
export function composeInvoiceName(parts: {
  namePrefix?: string;
  recipientName?: string;
  year?: number;
  numberSeq?: number;
}): string {
  const seq = parts.numberSeq;
  const year = parts.year;
  if (!year || !seq || seq < 1) return "(Entwurf)";
  const prefix = parts.namePrefix?.trim() || partnerAbbrev(parts.recipientName);
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}

export function parsePaymentTermsToDays(terms: string): number {
  const match = terms.match(/(\d+)\s*day/i);
  if (match) return parseInt(match[1], 10);
  const matchDe = terms.match(/(\d+)\s*tag/i);
  if (matchDe) return parseInt(matchDe[1], 10);
  return 14;
}
