/**
 * A listFiles row for the chat's Files card.
 *
 * Since #616 the chat's listFiles answers with MCP's File records (amounts in
 * cents, unsigned, with invoiceDirection; dates as ISO strings). The card was
 * written for the chat's old row, which carried display fields. This builds
 * them from the record, for display only: the model reads the record itself.
 * A row that already has them (a conversation saved before #616) is kept.
 */

import { fileDocumentAmount } from "@/lib/files/document-amount";
import type { FileResult } from "./types";

function isoOf(value: unknown): string | null {
  if (typeof value === "string" && value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (value && typeof value === "object") {
    const v = value as { _seconds?: unknown; seconds?: unknown };
    const seconds = typeof v._seconds === "number" ? v._seconds : typeof v.seconds === "number" ? v.seconds : null;
    if (seconds !== null) return new Date(seconds * 1000).toISOString();
  }
  return null;
}

/** dd.mm.yyyy of the stored calendar day (UTC midnight of the Vienna day). */
function dayFormatted(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function fileResultFromRecord(record: Record<string, unknown>): FileResult {
  if (typeof record.dateFormatted === "string") return record as unknown as FileResult;

  const date = isoOf(record.extractedDate) ?? isoOf(record.uploadedAt);
  const cents = fileDocumentAmount(record as Parameters<typeof fileDocumentAmount>[0]);
  // incoming = an expense, shown negative; as the chat's old row did.
  const signed = cents == null ? null : (record.invoiceDirection === "incoming" ? -cents : cents) / 100;
  const transactionIds = Array.isArray(record.transactionIds) ? (record.transactionIds as string[]) : [];
  const currency = typeof record.extractedCurrency === "string" && record.extractedCurrency ? record.extractedCurrency : "EUR";

  let amountFormatted: string | null = null;
  if (signed != null) {
    try {
      amountFormatted = new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(signed);
    } catch {
      amountFormatted = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(signed);
    }
  }

  return {
    id: String(record.id ?? ""),
    fileName: String(record.fileName ?? ""),
    fileType: String(record.fileType ?? ""),
    date,
    dateFormatted: dayFormatted(date),
    amount: signed,
    amountFormatted,
    partnerId: typeof record.partnerId === "string" ? record.partnerId : null,
    partnerName: typeof record.extractedPartner === "string" ? record.extractedPartner : null,
    transactionIds,
    hasTransaction: transactionIds.length > 0,
    extractionComplete: record.extractionComplete === true,
    isNotInvoice: record.isNotInvoice === true,
    uploadedAt: isoOf(record.uploadedAt) ?? "",
  };
}
