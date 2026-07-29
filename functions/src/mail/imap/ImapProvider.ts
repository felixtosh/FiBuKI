/**
 * IMAP implementation of MailProvider.
 *
 * Talks to any IMAP server (Migadu, Fastmail, dovecot, Gmail-via-app-password)
 * over imapflow. Owns the IMAP search dialect and BODYSTRUCTURE parsing, and
 * returns the same provider-neutral MailMessage shape the queue worker already
 * consumes from GmailProvider.
 *
 * Connection model: one short-lived connection per provider instance (= per
 * queue item). The worker calls search -> getMessage* -> getAttachment* ->
 * close() serially, so we open the mailbox read-only (EXAMINE) once and release
 * it in close(). No IDLE, no pooling.
 */

import { ImapFlow, MessageStructureObject } from "imapflow";
import { Readable } from "stream";
import {
  MailAttachment,
  MailMessage,
  MailMessageRef,
  MailProvider,
  MailSearchOptions,
  MailSearchPage,
} from "../provider";
import { INVOICE_KEYWORDS, INVOICE_MIME_TYPES, MAX_EMAILS_PER_BATCH } from "../constants";

/** Everything ImapProvider needs to reach one mailbox. */
export interface ImapConfig {
  host: string;
  port: number;
  /** Implicit TLS (port 993). */
  secure: boolean;
  /** Accept a self-signed server cert (internal hosts only). */
  allowSelfSigned: boolean;
  /** Mailbox to read; defaults to INBOX at the call site. */
  mailbox: string;
  /**
   * Narrow the server-side SEARCH with invoice keywords before the
   * BODYSTRUCTURE mimetype filter. Optimization only; some servers do weak
   * substring matching, so it can be disabled per integration.
   */
  keywordPrefilter: boolean;
  user: string;
  password: string;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * IMAP date literal (`YYYY-MM-DD`, imapflow formats it to `DD-Mon-YYYY`).
 *
 * Passed as a STRING, not a Date, on purpose: imapflow rewrites a Date `since`/
 * `before` into the WITHIN extension (`OLDER`/`YOUNGER <seconds-from-now>`) when
 * the server advertises WITHIN — which is a rolling window (wrong for a fixed
 * dateFrom/dateTo) and, for `before: ~now`, compiles to `OLDER 0`, which dovecot
 * rejects as "Invalid search interval". A string value keeps it on absolute
 * SINCE/BEFORE against INTERNALDATE.
 */
function imapDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** Filename of a body part, from disposition params or content-type name. */
function partFilename(node: MessageStructureObject): string | undefined {
  return (
    node.dispositionParameters?.filename ||
    node.parameters?.name ||
    undefined
  );
}

/**
 * Walk a BODYSTRUCTURE tree, keeping parts that are invoice-type attachments.
 * Mirror of GmailProvider's extractAttachments over Gmail payload parts.
 */
function extractAttachments(root: MessageStructureObject | undefined): MailAttachment[] {
  const out: MailAttachment[] = [];

  function walk(node: MessageStructureObject | undefined): void {
    if (!node) return;

    const type = (node.type || "").toLowerCase();
    const filename = partFilename(node);
    const isAttachment =
      node.disposition?.toLowerCase() === "attachment" || Boolean(filename);

    if (isAttachment && filename && INVOICE_MIME_TYPES.includes(type)) {
      out.push({
        // Non-multipart messages carry no part number; the whole body is "1".
        attachmentId: node.part || "1",
        filename,
        mimeType: type,
        size: node.size || 0,
      });
    }

    for (const child of node.childNodes || []) {
      walk(child);
    }
  }

  walk(root);
  return out;
}

/** Render an envelope address list as a raw `Name <addr>` From header. */
function formatFrom(
  from: Array<{ name?: string; address?: string }> | undefined
): string {
  if (!from || from.length === 0) return "";
  const { name, address } = from[0];
  if (name && address) return `${name} <${address}>`;
  return address || name || "";
}

export class ImapProvider implements MailProvider {
  private config: ImapConfig;
  private client: ImapFlow | null = null;

  constructor(config: ImapConfig) {
    this.config = config;
  }

  /** Lazily connect and select the mailbox read-only. */
  private async connect(): Promise<ImapFlow> {
    if (this.client) return this.client;

    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      ...(this.config.allowSelfSigned
        ? { tls: { rejectUnauthorized: false } }
        : {}),
    });

    await client.connect();
    // EXAMINE (read-only) — never writes \Seen or touches the maildir.
    await client.mailboxOpen(this.config.mailbox, { readOnly: true });
    this.client = client;
    return client;
  }

  async search(opts: MailSearchOptions): Promise<MailSearchPage> {
    const client = await this.connect();

    const query: Parameters<ImapFlow["search"]>[0] = {
      since: imapDate(opts.dateFrom),
      // IMAP `before` is exclusive on the date; +1 day makes dateTo inclusive.
      before: imapDate(addDays(opts.dateTo, 1)),
    };

    if (this.config.keywordPrefilter) {
      // (kw1 in subject OR body) OR (kw2 ...) — at least one keyword must hit.
      query.or = INVOICE_KEYWORDS.flatMap((k) => [{ subject: k }, { body: k }]);
    }

    const found = await client.search(query, { uid: true });
    const uids = (found || []).slice().sort((a, b) => b - a); // newest UID first

    // Cursor = last UID of the previous page; continue strictly below it.
    const cursor = opts.pageToken ? Number(opts.pageToken) : undefined;
    const remaining =
      cursor !== undefined ? uids.filter((u) => u < cursor) : uids;

    const page = remaining.slice(0, MAX_EMAILS_PER_BATCH);
    const hasMore = remaining.length > page.length;

    return {
      messages: page.map((uid) => ({ id: String(uid) })),
      nextPageToken:
        hasMore && page.length > 0 ? String(page[page.length - 1]) : undefined,
    };
  }

  async getMessage(ref: MailMessageRef): Promise<MailMessage> {
    const client = await this.connect();
    const uid = Number(ref.id);

    const msg = await client.fetchOne(
      String(uid),
      {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
      },
      { uid: true }
    );

    if (!msg) {
      throw new Error(`IMAP message not found for UID ${uid}`);
    }

    const envelope = msg.envelope;
    const internal =
      msg.internalDate instanceof Date
        ? msg.internalDate
        : msg.internalDate
          ? new Date(msg.internalDate)
          : envelope?.date || new Date(0);

    return {
      id: String(msg.uid ?? uid),
      messageId: envelope?.messageId || `${this.config.mailbox}:${msg.uid ?? uid}`,
      from: formatFrom(envelope?.from),
      subject: envelope?.subject || "",
      date: internal,
      attachments: extractAttachments(msg.bodyStructure),
    };
  }

  async getAttachment(
    message: MailMessage,
    attachment: MailAttachment
  ): Promise<Buffer> {
    const client = await this.connect();
    const { content } = await client.download(
      String(Number(message.id)),
      attachment.attachmentId,
      { uid: true }
    );
    // imapflow already decodes the transfer-encoding on the stream.
    return streamToBuffer(content);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // Best-effort: force-close the socket if a graceful logout fails.
      this.client.close();
    } finally {
      this.client = null;
    }
  }
}
