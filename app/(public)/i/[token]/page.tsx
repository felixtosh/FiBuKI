/**
 * Public invoice share route.
 *
 * Unauthenticated visitors with a valid `/i/{token}` URL see a clean
 * read-only invoice view and can download the PDF.
 *
 * Security:
 * - Firestore rules deny client reads to `invoiceShares/*`; this route
 *   uses the Admin SDK (server-only) to look up the share doc.
 * - Tokens are 32 random url-safe bytes (~43 chars) so guessing is infeasible.
 * - Returns 404 for unknown, revoked, or cancelled invoices.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { Invoice, InvoiceShare } from "@/types/invoice";
import { TaxFile } from "@/types/file";

import { PublicInvoiceView } from "./PublicInvoiceView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Rechnung | Fibuki",
  description: "Geteilte Rechnung, bereitgestellt von Fibuki.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function ShareInvoicePage({ params }: PageProps) {
  const { token } = await params;
  if (!token || token.length < 16) notFound();

  const db = getAdminDb();
  const shareRef = db.collection("invoiceShares").doc(token);
  const shareSnap = await shareRef.get();
  if (!shareSnap.exists) notFound();

  const share = shareSnap.data() as InvoiceShare | undefined;
  if (!share || share.revokedAt) notFound();

  const invoiceSnap = await db.collection("invoices").doc(share.invoiceId).get();
  if (!invoiceSnap.exists) notFound();

  const invoice = {
    id: invoiceSnap.id,
    ...(invoiceSnap.data() as Omit<Invoice, "id">),
  } as Invoice;

  if (invoice.status === "cancelled") notFound();

  // Point the download button at our own token-authenticated route
  // (./download) rather than the file's raw `downloadUrl`. The stored URL is a
  // privileged `/__storage/download/<path>` route that requires a Bearer token
  // an anonymous share visitor doesn't have, so it 401'd. The `/i/{token}/download`
  // route re-verifies the share token server-side and streams the bytes.
  // Only expose it once a PDF actually exists (storagePath is set at issue time).
  let downloadUrl: string | null = null;
  if (invoice.fileId) {
    const fileSnap = await db.collection("files").doc(invoice.fileId).get();
    if (fileSnap.exists) {
      const file = fileSnap.data() as TaxFile | undefined;
      if (file?.storagePath) {
        downloadUrl = `/i/${token}/download`;
      }
    }
  }

  // Fire-and-forget access tracking. Don't block render on this.
  shareRef
    .update({
      accessCount: FieldValue.increment(1),
      lastAccessedAt: FieldValue.serverTimestamp(),
    })
    .catch(() => {
      // Swallow: tracking is best-effort.
    });

  // Convert Firestore Timestamps to plain numbers so we can pass through
  // the server-client boundary safely.
  const safeInvoice = serializeInvoice(invoice);

  return <PublicInvoiceView invoice={safeInvoice} downloadUrl={downloadUrl} />;
}

/**
 * Serialized invoice safe to pass from server component to client component.
 * Firestore Timestamps -> ISO strings; everything else passed through.
 */
export interface SerializedInvoice {
  id: string;
  number: string;
  status: Invoice["status"];
  issuer: Invoice["issuer"];
  recipient: Invoice["recipient"];
  issueDate: string;
  paymentTerms: string;
  dueDate: string;
  lineItems: Invoice["lineItems"];
  notes?: string;
  currency: string;
  subtotal: number;
  vatAmount: number;
  total: number;
  paidAt?: string;
  /** Set on an Invoice Correction: the invoice it cancels (#133). */
  correctsInvoice?: { number: string; issueDate: string };
}

function tsToIso(ts: unknown): string {
  if (!ts) return "";
  if (typeof ts === "object" && ts !== null && "toDate" in ts) {
    const d = (ts as { toDate: () => Date }).toDate();
    return d.toISOString();
  }
  if (typeof ts === "object" && ts !== null && "_seconds" in ts) {
    const seconds = (ts as { _seconds: number })._seconds;
    return new Date(seconds * 1000).toISOString();
  }
  return "";
}

function serializeInvoice(invoice: Invoice): SerializedInvoice {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    issuer: invoice.issuer,
    recipient: invoice.recipient,
    issueDate: tsToIso(invoice.issueDate),
    paymentTerms: invoice.paymentTerms,
    dueDate: tsToIso(invoice.dueDate),
    lineItems: invoice.lineItems,
    notes: invoice.notes,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    vatAmount: invoice.vatAmount,
    total: invoice.total,
    paidAt: invoice.paidAt ? tsToIso(invoice.paidAt) : undefined,
    correctsInvoice: invoice.correctsInvoice
      ? {
          number: invoice.correctsInvoice.number,
          issueDate: tsToIso(invoice.correctsInvoice.issueDate),
        }
      : undefined,
  };
}
