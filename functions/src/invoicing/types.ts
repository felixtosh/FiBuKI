import { Timestamp } from "firebase-admin/firestore";

export type InvoiceStatus = "draft" | "issued" | "sent" | "paid" | "cancelled";

export interface InvoicePartnerAddress {
  street?: string;
  city?: string;
  postalCode?: string;
  country: string;
}

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
  address?: InvoicePartnerAddress;
  iban: string;
  bic?: string;
}

export interface InvoiceRecipientSnapshot {
  partnerId: string;
  partnerType: "user" | "global";
  name: string;
  vatId?: string;
  address?: InvoicePartnerAddress;
}

export interface Invoice {
  id: string;
  userId: string;
  number: string;
  status: InvoiceStatus;
  /** Optional user prefix used to compose the display name (e.g. "INV"). */
  namePrefix?: string;
  /** Integer sequence used to compose the display name (zero-padded). */
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

export function partnerAbbrev(name?: string): string {
  if (!name) return "XXX";
  const letters = name.replace(/[^A-Za-zÄÖÜäöüß]/g, "");
  const upper = letters.toUpperCase();
  if (upper.length === 0) return "XXX";
  return upper.slice(0, 3).padEnd(3, "X");
}

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
