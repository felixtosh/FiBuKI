"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { ContentOverlay } from "@/components/ui/content-overlay";
import { Invoice } from "@/types/invoice";
import { InvoiceDocument } from "./InvoiceDocument";
import { PdfPageViewer } from "@/components/files/pdf-page-viewer";
import { buildEpcPayload } from "@/lib/invoicing/epcPayload";

// @react-pdf/renderer is heavy and browser-only.
const PDFViewer = dynamic(
  () => import("@react-pdf/renderer").then((m) => m.PDFViewer),
  { ssr: false }
);

interface InvoiceViewerOverlayProps {
  open: boolean;
  onClose: () => void;
  invoice: Invoice;
  /** If the invoice has been issued, downloadUrl is set on the linked TaxFile. */
  downloadUrl?: string | null;
  fileName?: string | null;
}

/**
 * Full-content overlay for previewing an invoice PDF. Mirrors the file viewer
 * overlay pattern used for regular files. For draft invoices the PDF is
 * rendered live via @react-pdf/renderer's <PDFViewer>; for issued invoices
 * the persisted PDF is loaded from storage.
 */
export function InvoiceViewerOverlay({
  open,
  onClose,
  invoice,
  downloadUrl,
  fileName,
}: InvoiceViewerOverlayProps) {
  const isDraft = invoice.status === "draft" || !downloadUrl;
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [qrReady, setQrReady] = useState(false);

  // EPC / Girocode QR for live preview (drafts only). Issued invoices already
  // have the QR baked into the persisted PDF.
  useEffect(() => {
    if (!isDraft || !open) {
      setQrReady(true);
      return;
    }
    let cancelled = false;
    const iban = invoice.issuer?.iban;
    if (!iban) {
      setQrDataUrl("");
      setQrReady(true);
      return;
    }
    setQrReady(false);
    const epc = buildEpcPayload({
      bic: invoice.issuer?.bic,
      name: invoice.issuer?.name ?? "",
      iban,
      amountCents: invoice.total ?? 0,
      remittance: invoice.number ? `Rechnung ${invoice.number}` : undefined,
    });
    QRCode.toDataURL(epc, { margin: 0, width: 256 })
      .then((url) => {
        if (!cancelled) {
          setQrDataUrl(url);
          setQrReady(true);
        }
      })
      .catch((err) => {
        console.error("EPC QR generation failed:", err);
        if (!cancelled) {
          setQrDataUrl("");
          setQrReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    isDraft,
    open,
    invoice.issuer?.iban,
    invoice.issuer?.bic,
    invoice.issuer?.name,
    invoice.total,
    invoice.number,
  ]);

  const headerActions =
    !isDraft && downloadUrl ? (
      <>
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <a href={downloadUrl} download={fileName ?? `Rechnung-${invoice.number}.pdf`}>
            <Download className="h-4 w-4" />
          </a>
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </>
    ) : null;

  const title =
    fileName ||
    (invoice.number ? `Rechnung ${invoice.number}` : "Rechnungsentwurf");

  return (
    <ContentOverlay
      open={open}
      onClose={onClose}
      title={title}
      headerActions={headerActions}
    >
      <div className="h-full bg-muted/30">
        {isDraft ? (
          !qrReady ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Vorschau wird erstellt…
            </div>
          ) : (
            <PDFViewer width="100%" height="100%" showToolbar={false}>
              <InvoiceDocument
                invoice={invoice}
                qrDataUrl={qrDataUrl || undefined}
              />
            </PDFViewer>
          )
        ) : (
          <PdfPageViewer url={downloadUrl!} scale={1} rotation={0} className="h-full" />
        )}
      </div>
    </ContentOverlay>
  );
}
