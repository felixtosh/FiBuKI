/**
 * Shared PDF component for invoices.
 * Rendered server-side via @react-pdf/renderer.
 *
 * Layout is a single A4 page using @react-pdf flex primitives.
 */

import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";
import { Invoice, InvoicePartnerAddress } from "./types";

interface InvoiceDocumentProps {
  invoice: Invoice;
  /** Data URL of the EPC / Girocode QR (PNG). */
  qrDataUrl?: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(value: unknown): string {
  if (!value) return "";
  // Admin Timestamp has toDate(); Date is also accepted.
  const d =
    typeof (value as { toDate?: () => Date }).toDate === "function"
      ? (value as { toDate: () => Date }).toDate()
      : (value as Date);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatEur(cents: number): string {
  const safe = Math.round(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const euros = Math.floor(abs / 100);
  const remainder = abs % 100;
  // German formatting: thousands sep ".", decimal sep ","
  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${eurosStr},${pad2(remainder)} ${"€"}`;
}

function formatAddress(addr?: InvoicePartnerAddress): string[] {
  if (!addr) return [];
  const lines: string[] = [];
  if (addr.street) lines.push(addr.street);
  const postalCity = [addr.postalCode, addr.city].filter(Boolean).join(" ");
  if (postalCity) lines.push(postalCity);
  if (addr.country) lines.push(addr.country);
  return lines;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#111",
    lineHeight: 1.4,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30,
  },
  issuerBlock: {
    width: "55%",
  },
  invoiceMetaBlock: {
    width: "40%",
    alignItems: "flex-end",
  },
  invoiceTitle: {
    fontSize: 22,
    fontWeight: "bold",
    marginBottom: 6,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: 2,
  },
  metaLabel: {
    color: "#555",
    marginRight: 6,
  },
  recipientBlock: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 9,
    color: "#777",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  partyName: {
    fontWeight: "bold",
    marginBottom: 2,
  },
  vatLine: {
    color: "#555",
    marginTop: 2,
  },
  itemsTable: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: "#ddd",
  },
  itemsHeader: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#ddd",
    fontWeight: "bold",
    fontSize: 9,
    color: "#555",
    textTransform: "uppercase",
  },
  itemsRow: {
    flexDirection: "row",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  colDescription: { flex: 4 },
  colQty: { flex: 1, textAlign: "right" },
  colUnit: { flex: 1.5, textAlign: "right" },
  colVat: { flex: 1, textAlign: "right" },
  colTotal: { flex: 1.5, textAlign: "right" },
  totalsBlock: {
    marginTop: 16,
    alignSelf: "flex-end",
    width: "45%",
  },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  totalsLabel: { color: "#555" },
  totalsValue: { textAlign: "right" },
  grandTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#333",
    fontWeight: "bold",
    fontSize: 12,
  },
  footer: {
    marginTop: 30,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  paymentBlock: {
    width: "60%",
  },
  qrBlock: {
    width: "35%",
    alignItems: "flex-end",
  },
  qrImage: {
    width: 90,
    height: 90,
  },
  qrCaption: {
    fontSize: 8,
    color: "#777",
    marginTop: 4,
    textAlign: "right",
  },
  notesBlock: {
    marginTop: 20,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#eee",
    fontSize: 9,
    color: "#555",
  },
});

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const PartyAddress: React.FC<{ lines: string[] }> = ({ lines }) => (
  <View>
    {lines.map((line, i) => (
      <Text key={i}>{line}</Text>
    ))}
  </View>
);

const ItemsTable: React.FC<{ invoice: Invoice }> = ({ invoice }) => (
  <View style={styles.itemsTable}>
    <View style={styles.itemsHeader}>
      <Text style={styles.colDescription}>Beschreibung</Text>
      <Text style={styles.colQty}>Menge</Text>
      <Text style={styles.colUnit}>Einzelpreis</Text>
      <Text style={styles.colVat}>USt.</Text>
      <Text style={styles.colTotal}>Gesamt</Text>
    </View>
    {invoice.lineItems.map((item) => {
      const lineNet = Math.round(item.quantity * item.unitPrice);
      return (
        <View key={item.id} style={styles.itemsRow}>
          <Text style={styles.colDescription}>{item.description}</Text>
          <Text style={styles.colQty}>{item.quantity}</Text>
          <Text style={styles.colUnit}>{formatEur(item.unitPrice)}</Text>
          <Text style={styles.colVat}>{item.vatRate}%</Text>
          <Text style={styles.colTotal}>{formatEur(lineNet)}</Text>
        </View>
      );
    })}
  </View>
);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const InvoiceDocument: React.FC<InvoiceDocumentProps> = ({
  invoice,
  qrDataUrl,
}) => {
  const issuerAddress = formatAddress(invoice.issuer.address);
  const recipientAddress = formatAddress(invoice.recipient.address);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.headerRow}>
          <View style={styles.issuerBlock}>
            <Text style={styles.partyName}>{invoice.issuer.name}</Text>
            <PartyAddress lines={issuerAddress} />
            {invoice.issuer.vatId ? (
              <Text style={styles.vatLine}>UID: {invoice.issuer.vatId}</Text>
            ) : null}
          </View>
          <View style={styles.invoiceMetaBlock}>
            <Text style={styles.invoiceTitle}>RECHNUNG</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Nr.:</Text>
              <Text>{invoice.number}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Datum:</Text>
              <Text>{formatDate(invoice.issueDate)}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Fällig:</Text>
              <Text>{formatDate(invoice.dueDate)}</Text>
            </View>
          </View>
        </View>

        {/* Recipient */}
        <View style={styles.recipientBlock}>
          <Text style={styles.sectionLabel}>Rechnung an:</Text>
          <Text style={styles.partyName}>{invoice.recipient.name}</Text>
          <PartyAddress lines={recipientAddress} />
          {invoice.recipient.vatId ? (
            <Text style={styles.vatLine}>UID: {invoice.recipient.vatId}</Text>
          ) : null}
        </View>

        {/* Items */}
        <ItemsTable invoice={invoice} />

        {/* Totals */}
        <View style={styles.totalsBlock}>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>Zwischensumme (netto)</Text>
            <Text style={styles.totalsValue}>{formatEur(invoice.subtotal)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsLabel}>USt.</Text>
            <Text style={styles.totalsValue}>{formatEur(invoice.vatAmount)}</Text>
          </View>
          <View style={styles.grandTotalRow}>
            <Text>Gesamt</Text>
            <Text>{formatEur(invoice.total)}</Text>
          </View>
        </View>

        {/* Footer (payment info + QR) */}
        <View style={styles.footer}>
          <View style={styles.paymentBlock}>
            <Text style={styles.sectionLabel}>Bitte überweisen Sie auf:</Text>
            <Text>{invoice.issuer.name}</Text>
            <Text>IBAN: {invoice.issuer.iban}</Text>
            {invoice.issuer.bic ? <Text>BIC: {invoice.issuer.bic}</Text> : null}
            <Text>Verwendungszweck: Rechnung {invoice.number}</Text>
          </View>
          <View style={styles.qrBlock}>
            {qrDataUrl ? (
              <>
                <Image src={qrDataUrl} style={styles.qrImage} />
                <Text style={styles.qrCaption}>EPC QR (Girocode)</Text>
              </>
            ) : null}
          </View>
        </View>

        {/* Notes */}
        {invoice.notes ? (
          <View style={styles.notesBlock}>
            <Text>{invoice.notes}</Text>
          </View>
        ) : null}
      </Page>
    </Document>
  );
};

export default InvoiceDocument;
