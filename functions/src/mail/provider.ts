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

/** One page of a search over a date window. */
export interface MailSearchPage {
  messages: MailMessageRef[];
  /** Provider-opaque continuation token; absent when the window is exhausted. */
  nextPageToken?: string;
}

export interface MailSearchOptions {
  dateFrom: Date;
  dateTo: Date;
  pageToken?: string;
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
