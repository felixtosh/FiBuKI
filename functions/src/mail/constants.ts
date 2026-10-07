/**
 * Shared mail-ingestion constants.
 *
 * These define what "an invoice-type attachment" means and how big a search
 * batch is. They are provider-neutral: Gmail builds them into a query string,
 * IMAP applies the mimetype filter against BODYSTRUCTURE. Keeping them in one
 * place stops the two providers from drifting.
 */

/** Max messages fetched per search page (both providers paginate to this). */
export const MAX_EMAILS_PER_BATCH = 50;

/** Invoice/receipt keywords (German + English) used to narrow a search. */
export const INVOICE_KEYWORDS = [
  // German
  "Rechnung",
  "Beleg",
  "Quittung",
  "Faktura",
  "Zahlungsbeleg",
  "Kaufbeleg",
  "Zahlungsbestätigung",
  // English
  "Invoice",
  "Receipt",
  "Bill",
  "Payment confirmation",
  "Order confirmation",
];

/**
 * Ceiling on a bounded IMAP fetch-and-filter (#240).
 *
 * A mailbox whose server rejects the keyword SEARCH still has to be searchable,
 * so the provider falls back to matching Subject/From itself — but only over
 * the newest messages in the window. Walking an unbounded mailbox on a
 * self-host box is a hang, not a slow search, and the caller is told the scan
 * was bounded rather than left to assume the window was exhausted.
 */
export const MAX_IMAP_SCAN_MESSAGES = 200;

/**
 * Ceiling on the candidates one IMAP search page reads BODYSTRUCTURE for
 * (#768). IMAP SEARCH cannot ask for attachments, so the provider checks the
 * matches itself, newest first, until the page is full; in a mailbox of
 * notification mail that could be the whole window. At the bound it stops,
 * says so, and returns a cursor so the caller can ask for the next page.
 */
export const MAX_IMAP_ATTACHMENT_CHECKS = 200;

/** MIME types we treat as invoice attachments. */
export const INVOICE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];

/**
 * Whether a message part is an invoice-type attachment: one of
 * INVOICE_MIME_TYPES, or a PDF sent as `application/octet-stream`, which
 * plenty of billing systems do. Both providers filter by this one rule.
 */
export function isInvoiceAttachment(mimeType: string, filename: string): boolean {
  const type = mimeType.toLowerCase();
  if (INVOICE_MIME_TYPES.includes(type)) return true;
  return type === "application/octet-stream" && filename.toLowerCase().endsWith(".pdf");
}
