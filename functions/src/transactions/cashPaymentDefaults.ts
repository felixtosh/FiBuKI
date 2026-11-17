/**
 * What a File says its Cash Payment was (#789), and whether to offer one.
 *
 * Shared by the Cash Payment writer (the defaults an MCP client or the chat
 * may override) and the File detail panel (the values the add-payment dialog
 * opens with, which the User checks before saving), so the two never read a
 * File differently. Browser-safe: no imports, a Timestamp from either SDK is
 * read through its `toDate()`.
 */

/** The fields of a File this module reads; a stored File or the browser's TaxFile. */
export interface CashPaymentFileFields {
  fileName?: string | null;
  extractedDate?: unknown;
  extractedAmount?: number | null;
  extractedTipAmount?: number | null;
  extractedPartner?: string | null;
  extractedIssuer?: { name?: string | null } | null;
  extractedAdditionalFields?: Array<{ key?: unknown; value?: unknown }> | null;
  invoiceDirection?: string | null;
  partnerId?: string | null;
  partnerType?: string | null;
  transactionIds?: string[] | null;
  deletedAt?: unknown;
  copyOfFileId?: string | null;
}

export interface CashPaymentDefaults {
  /** The File's day, `YYYY-MM-DD`. */
  date: string | null;
  /** Signed integer cents: negative is money out. */
  amount: number | null;
  name: string | null;
  /** The User's own Partner on the File; a Global one is left to the payee rule. */
  partnerId: string | null;
}

/** The File's day as `YYYY-MM-DD`, read from the UTC date part (the dates rule). */
function fileDay(value: unknown): string | null {
  const toDate = (value as { toDate?: unknown } | null | undefined)?.toDate;
  const date =
    typeof toDate === "function" ? (value as { toDate: () => Date }).toDate() : value instanceof Date ? value : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * What the File says the payment was: its day; its gross amount (the
 * VAT-bearing total plus a printed tip, what was handed over) signed by
 * direction (an outgoing invoice is money in, anything else money out); its
 * Partner; and a name (the extracted Partner, the issuer, or the file name).
 */
export function cashPaymentDefaultsFromFile(file: CashPaymentFileFields): CashPaymentDefaults {
  const gross = typeof file.extractedAmount === "number" ? Math.abs(file.extractedAmount) : null;
  const tip = typeof file.extractedTipAmount === "number" ? Math.abs(file.extractedTipAmount) : 0;
  const amount =
    gross === null || gross + tip === 0 ? null : (gross + tip) * (file.invoiceDirection === "outgoing" ? 1 : -1);
  const name =
    [file.extractedPartner, file.extractedIssuer?.name, file.fileName].find(
      (v): v is string => typeof v === "string" && v.trim() !== ""
    ) ?? null;
  const partnerId =
    typeof file.partnerId === "string" && file.partnerId && file.partnerType !== "global" ? file.partnerId : null;
  return { date: fileDay(file.extractedDate), amount, name: name?.trim() ?? null, partnerId };
}

/** True when the File's extraction says it was paid in cash. */
export function fileSaysPaidInCash(file: CashPaymentFileFields): boolean {
  const rows = Array.isArray(file.extractedAdditionalFields) ? file.extractedAdditionalFields : [];
  return rows.some((r) => r?.key === "paymentMethod" && r?.value === "cash");
}

/**
 * Whether the File detail panel offers "Add as cash payment": `promoted` on a
 * File the extraction says was paid in cash, `offered` on any other File with
 * no Transaction, null on a connected, deleted or Copy File.
 */
export function cashPaymentOffer(file: CashPaymentFileFields): "promoted" | "offered" | null {
  if ((file.transactionIds?.length ?? 0) > 0 || file.deletedAt || file.copyOfFileId) return null;
  return fileSaysPaidInCash(file) ? "promoted" : "offered";
}
