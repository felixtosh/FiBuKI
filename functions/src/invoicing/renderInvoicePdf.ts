/**
 * Renders a server-side PDF for an Invoice via @react-pdf/renderer.
 */

import { renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import QRCode from "qrcode";
import { InvoiceDocument } from "./invoiceDocument";
import { buildEpcPayload } from "./epcPayload";
import { Invoice } from "./types";

export async function renderInvoicePdf(invoice: Invoice): Promise<Buffer> {
  // Build EPC / Girocode payload from issuer + total.
  const epc = buildEpcPayload({
    bic: invoice.issuer.bic,
    name: invoice.issuer.name,
    iban: invoice.issuer.iban,
    amountCents: invoice.total,
    remittance: `Rechnung ${invoice.number}`,
  });

  // QR rendered server-side as a PNG data URL embedded into the PDF.
  const qrDataUrl = await QRCode.toDataURL(epc, {
    margin: 0,
    width: 256,
    errorCorrectionLevel: "M",
  });

  // @react-pdf/renderer's typings expect a `ReactElement<DocumentProps>` from its own JSX
  // namespace. Our InvoiceDocument is wrapped in <Document>, so the runtime contract is met.
  // The generic is erased in CJS output, so we coerce through `any`.
  const element = React.createElement(InvoiceDocument, { invoice, qrDataUrl });

  const buffer = (await renderToBuffer(element as any)) as unknown as Buffer;
  return buffer;
}
