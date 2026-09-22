/**
 * Provider-neutral mail interface.
 *
 * The email-ingestion pipeline (search for invoice-type attachments, fetch
 * them, file them) is provider-shaped: today Gmail, tomorrow IMAP/Outlook.
 * This is the seam. A concrete provider hides the wire protocol and returns
 * already-parsed messages with their invoice-type attachments pre-filtered.
 *
 * See mail/index.ts for the factory and mail/GmailProvider.ts for the first
 * implementation. The queue worker (gmail/gmailSyncQueue.ts) drives this
 * interface and knows nothing about Gmail payload trees or IMAP bodystructures.
 */

/** Opaque cursor identifying one message within a provider. */
export interface MailMessageRef {
  id: string;
}

/** One invoice-type attachment on a message (already filtered by mimetype). */
export interface MailAttachment {
  /** Provider-opaque handle: Gmail attachmentId, IMAP bodystructure part id, ... */
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A parsed message: headers of interest plus its invoice-type attachments. */
export interface MailMessage {
  /** Provider message id (Gmail message id, IMAP UID, ...). */
  id: string;
  /** RFC822 Message-ID header if present; stable across providers. */
  messageId: string | null;
  /** Raw `From` header, e.g. `"Acme GmbH" <billing@acme.example>`. */
  from: string;
  subject: string;
  /** Internal/received date of the message. */
  date: Date;
  /** Attachments already narrowed to invoice-type mimetypes. */
  attachments: MailAttachment[];
}

/**
 * What a search asks a mailbox for, in words both shipped providers can
 * execute (#240). No provider dialect crosses this seam: the same terms become
 * a Gmail query string on one side and IMAP SEARCH keys on the other, and the
 * caller never learns which it hit.
 *
 * Every field is optional, and a search that names no term at all is the
 * invoice sweep the Sync worker has always run — the shared keyword list, PDFs
 * only — so its call keeps its exact meaning.
 *
 * The MIME constraint is deliberately absent: INVOICE_MIME_TYPES is one shared
 * constant both providers filter attachments by, not a per-search choice.
 */
export interface MailSearchTerms {
  /**
   * Free text. A message must match EVERY keyword — that is what a typed
   * search box, a learned Partner pattern and a two-word suggestion all mean,
   * and it is what Gmail's own juxtaposition has always done for them.
   *
   * Absent is the one place ANY is meant: it stands for the invoice keyword
   * list in mail/constants.ts, which is a sweep for "some invoice-ish word",
   * and is the call the Sync worker has always made.
   */
  keywords?: string[];
  /** Sender address or domain, matched against the From header. */
  from?: string;
  /**
   * Attachment filename fragments. Not every provider can search these — one
   * that cannot says so in `limitations` rather than dropping them.
   */
  filenames?: string[];
  /** Require an invoice-type attachment. Absent means true. */
  hasAttachment?: boolean;
}

/**
 * One term of a search, named so a provider can report on it.
 *
 * `rawQuery` and `threads` are not MailSearchTerms fields: they are asks the
 * manual attach path can still make of a Gmail mailbox (a raw Gmail query from
 * the automation callers, thread expansion) and which nothing else can answer.
 * They are named here so one report shape covers every constraint a search can
 * carry, whoever ends up unable to execute it.
 */
export type MailSearchConstraint =
  | keyof MailSearchTerms
  | "dateWindow"
  | "rawQuery"
  | "threads";

/**
 * A constraint a provider could not execute as asked, carried back on the page
 * instead of being silently dropped.
 *
 * - `scanned` — honoured, but locally over a bounded slice of the mailbox
 *   rather than by the server. Results are correct as far as the slice reaches.
 * - `unsupported` — not honoured at all. The results are WIDER than asked for,
 *   so a caller that needs the constraint has to apply it itself.
 */
export interface MailSearchLimitation {
  constraint: MailSearchConstraint;
  handling: "scanned" | "unsupported";
  detail: string;
}

/** One page of a search over a date window. */
export interface MailSearchPage {
  messages: MailMessageRef[];
  /** Provider-opaque continuation token; absent when the window is exhausted. */
  nextPageToken?: string;
  /** Constraints this provider could not execute as asked. Absent when it could. */
  limitations?: MailSearchLimitation[];
}

export interface MailSearchOptions extends MailSearchTerms {
  dateFrom: Date;
  dateTo: Date;
  pageToken?: string;
  /** Max messages on this page. Absent means MAX_EMAILS_PER_BATCH. */
  limit?: number;
}

/**
 * A source of invoice-type attachments for one connected mailbox.
 * Implementations own their query dialect and message parsing.
 */
export interface MailProvider {
  /** Search one date window for invoice-type messages, paginated. */
  search(opts: MailSearchOptions): Promise<MailSearchPage>;

  /** Fetch headers + attachment metadata (not bytes) for one message. */
  getMessage(ref: MailMessageRef): Promise<MailMessage>;

  /** Fetch one attachment's bytes. */
  getAttachment(message: MailMessage, attachment: MailAttachment): Promise<Buffer>;

  /** Release any held connections. No-op for stateless (fetch-based) providers. */
  close(): Promise<void>;
}
