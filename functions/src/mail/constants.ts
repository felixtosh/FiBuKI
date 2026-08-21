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

/**
 * Providers the background sync machinery (daily scheduled sync, the
 * after-import gap sync) treats as mailboxes to keep current. Both legs of
 * the sync worker already speak IMAP; only the enqueue side used to ask for
 * Gmail alone, which left an IMAP mailbox synced exactly once.
 */
export const SYNCABLE_MAIL_PROVIDERS = ["gmail", "imap"] as const;

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

/**
 * Trailing window a *manually pressed* sync always re-scans, on top of any
 * gap the range detection finds.
 *
 * Three days rather than a week because attachment de-duplication happens by
 * content hash *after* download: a wider window re-downloads every attachment
 * in it on every press. The button's job is "mail that arrived in the last few
 * hours", so three days is generous slack, not a backfill. Re-scanning is
 * otherwise safe — the worker only ever expands an integration's synced range,
 * never contracts it.
 */
export const MANUAL_SYNC_WINDOW_DAYS = 3;
