"use client";

/**
 * Read-only public invoice view rendered at /i/{token}.
 * Renders the invoice as plain HTML (not the PDF component) for accessibility,
 * fast load, and good print output.
 */

import { Download } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { lineItemColumnCents } from "@/lib/invoicing/invoice-totals";
import { buildEpcPayload } from "@/lib/invoicing/epcPayload";

import type { SerializedInvoice } from "./page";

interface PublicInvoiceViewProps {
  invoice: SerializedInvoice;
  downloadUrl: string | null;
}

function formatGermanDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("de-DE", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

function formatAddressLines(addr?: {
  street?: string;
  postalCode?: string;
  city?: string;
  country: string;
}): string[] {
  if (!addr) return [];
  const lines: string[] = [];
  if (addr.street) lines.push(addr.street);
  const cityLine = [addr.postalCode, addr.city].filter(Boolean).join(" ");
  if (cityLine) lines.push(cityLine);
  if (addr.country) lines.push(addr.country);
  return lines;
}

export function PublicInvoiceView({
  invoice,
  downloadUrl,
}: PublicInvoiceViewProps) {
  const issuerAddress = formatAddressLines(invoice.issuer.address);
  const recipientAddress = formatAddressLines(invoice.recipient.address);

  const showStatusBadge =
    invoice.status === "paid" || invoice.status === "cancelled";

  // An Invoice Correction (#133) names the invoice it cancels and asks for
  // no payment, like its PDF.
  const corrects = invoice.correctsInvoice;

  // EPC / Girocode QR — only when we have an IBAN and a non-zero total.
  // The PDF footer renders the same payload; the HTML view stays close to
  // the PDF layout for printability.
  const epcPayload =
    invoice.issuer.iban && invoice.total > 0
      ? buildEpcPayload({
          bic: invoice.issuer.bic,
          name: invoice.issuer.name,
          iban: invoice.issuer.iban,
          amountCents: invoice.total,
          remittance: invoice.number ? `Rechnung ${invoice.number}` : undefined,
        })
      : null;

  return (
    <div className="min-h-full bg-muted/30 py-8 px-4 sm:py-12">
      <div className="mx-auto max-w-3xl">
        {/* Header card */}
        <div className="rounded-t-xl bg-background border border-b-0 px-6 py-6 sm:px-10 sm:py-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              {corrects ? "Rechnungskorrektur" : "Rechnung"} {invoice.number}
            </h1>
            {corrects && (
              <p className="text-sm text-muted-foreground">
                Storno zu Rechnung {corrects.number} vom{" "}
                {formatGermanDate(corrects.issueDate)}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {invoice.issuer.name}
            </p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-2">
            {showStatusBadge && (
              <Badge
                variant="outline"
                className={
                  invoice.status === "paid"
                    ? "border-green-300 bg-green-50 text-green-900"
                    : "border-red-300 bg-red-50 text-red-900"
                }
              >
                {invoice.status === "paid" ? "Bezahlt" : "Storniert"}
              </Badge>
            )}
            {downloadUrl && (
              <Button asChild size="sm" className="gap-2">
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  download
                >
                  <Download className="h-4 w-4" />
                  PDF herunterladen
                </a>
              </Button>
            )}
          </div>
        </div>

        {/* Invoice body */}
        <div className="rounded-b-xl bg-background border border-t-0 px-6 py-8 sm:px-10 sm:py-10 space-y-8">
          {/* Issuer / Recipient blocks */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                Von
              </h2>
              <div className="text-sm space-y-0.5">
                <div className="font-medium text-base">
                  {invoice.issuer.name}
                </div>
                {issuerAddress.map((line, i) => (
                  <div key={i} className="text-muted-foreground">
                    {line}
                  </div>
                ))}
                {invoice.issuer.vatId && (
                  <div className="text-muted-foreground pt-1">
                    UID: {invoice.issuer.vatId}
                  </div>
                )}
                {invoice.issuer.iban && (
                  <div className="text-muted-foreground">
                    IBAN: {invoice.issuer.iban}
                  </div>
                )}
              </div>
            </section>

            <section>
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                An
              </h2>
              <div className="text-sm space-y-0.5">
                <div className="font-medium text-base">
                  {invoice.recipient.name}
                </div>
                {recipientAddress.map((line, i) => (
                  <div key={i} className="text-muted-foreground">
                    {line}
                  </div>
                ))}
                {invoice.recipient.vatId && (
                  <div className="text-muted-foreground pt-1">
                    UID: {invoice.recipient.vatId}
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 py-4 border-y text-sm">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Rechnungsdatum
              </div>
              <div className="mt-1">{formatGermanDate(invoice.issueDate)}</div>
            </div>
            {!corrects && (
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Fällig am
                </div>
                <div className="mt-1">{formatGermanDate(invoice.dueDate)}</div>
              </div>
            )}
            {!corrects && (
              <div className="col-span-2 sm:col-span-1">
                <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Zahlungsfrist
                </div>
                <div className="mt-1">{invoice.paymentTerms}</div>
              </div>
            )}
          </div>

          {/* Line items */}
          <section>
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
              Positionen
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">Beschreibung</th>
                    <th className="py-2 px-2 font-medium text-right">Menge</th>
                    <th className="py-2 px-2 font-medium text-right">
                      Einzelpreis
                    </th>
                    <th className="py-2 px-2 font-medium text-right">USt</th>
                    <th className="py-2 pl-2 font-medium text-right">Summe</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems.map((item) => {
                    // Per-line column is NET (Austrian convention), matching
                    // the PDF renderers. USt is summed separately below.
                    const lineCents = lineItemColumnCents(item);
                    return (
                      <tr key={item.id} className="border-b last:border-b-0">
                        <td className="py-3 pr-2 align-top">
                          {item.description}
                        </td>
                        <td className="py-3 px-2 text-right align-top tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="py-3 px-2 text-right align-top tabular-nums">
                          {formatCurrency(item.unitPrice, invoice.currency)}
                        </td>
                        <td className="py-3 px-2 text-right align-top tabular-nums">
                          {item.vatRate}%
                        </td>
                        <td className="py-3 pl-2 text-right align-top tabular-nums font-medium">
                          {formatCurrency(lineCents, invoice.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Totals */}
          <section className="flex justify-end">
            <div className="w-full sm:w-72 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Zwischensumme</span>
                <span className="tabular-nums">
                  {formatCurrency(invoice.subtotal, invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">USt</span>
                <span className="tabular-nums">
                  {formatCurrency(invoice.vatAmount, invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between border-t pt-2 font-semibold text-base">
                <span>Gesamt</span>
                <span className="tabular-nums">
                  {formatCurrency(invoice.total, invoice.currency)}
                </span>
              </div>
            </div>
          </section>

          {/* Payment block — IBAN/BIC text on the left, EPC/Girocode QR
              on the right. Mirrors the PDF footer so the HTML view prints
              close to the PDF. Only rendered when we have enough data to
              produce a valid EPC payload (issuer.iban + non-zero total). */}
          {!corrects && (invoice.issuer.iban || epcPayload) && (
            <section className="pt-4 border-t">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
                Zahlung
              </h2>
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div className="text-sm space-y-0.5 min-w-0">
                  <div className="font-medium">{invoice.issuer.name}</div>
                  {invoice.issuer.iban && (
                    <div className="text-muted-foreground">
                      IBAN: <span className="font-mono">{invoice.issuer.iban}</span>
                    </div>
                  )}
                  {invoice.issuer.bic && (
                    <div className="text-muted-foreground">
                      BIC: <span className="font-mono">{invoice.issuer.bic}</span>
                    </div>
                  )}
                  <div className="text-muted-foreground pt-1">
                    Verwendungszweck:{" "}
                    <span className="font-mono">Rechnung {invoice.number}</span>
                  </div>
                  <div className="text-muted-foreground">
                    Betrag:{" "}
                    <span className="tabular-nums font-medium text-foreground">
                      {formatCurrency(invoice.total, invoice.currency)}
                    </span>
                  </div>
                </div>
                {epcPayload && (
                  <div className="flex flex-col items-center sm:items-end gap-1 shrink-0">
                    <div className="rounded-md border bg-white p-2">
                      <QRCodeSVG
                        value={epcPayload}
                        size={128}
                        level="M"
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      Mit Banking-App scannen
                    </span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Notes */}
          {invoice.notes && (
            <section className="pt-2 border-t">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                Anmerkungen
              </h2>
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {invoice.notes}
              </p>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
          <div>
            Bereitgestellt von{" "}
            <a
              href="https://fibuki.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              Fibuki
            </a>
          </div>
          <div>Rechnung {invoice.number}</div>
        </div>
      </div>
    </div>
  );
}
