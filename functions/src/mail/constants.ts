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

/** MIME types we treat as invoice attachments. */
export const INVOICE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];
