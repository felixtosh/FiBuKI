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
  MailSearchLimitation,
  MailSearchOptions,
  MailSearchPage,
} from "../provider";
import {
  INVOICE_KEYWORDS,
  INVOICE_MIME_TYPES,
  MAX_EMAILS_PER_BATCH,
  MAX_IMAP_SCAN_MESSAGES,
} from "../constants";

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

/** One IMAP SEARCH query object, as imapflow's `search()` takes it. */
type ImapSearchQuery = Parameters<ImapFlow["search"]>[0];

/** `kw` in the Subject or the body — one keyword, wherever it shows up. */
function keywordClause(keyword: string): ImapSearchQuery {
  return { or: [{ subject: keyword }, { body: keyword }] };
}

/**
 * The invoice sweep: ANY of the shared keywords hits. One flat OR, the exact
 * shape the Sync worker has sent since before terms existed.
 */
function anyKeyword(keywords: string[]): ImapSearchQuery {
  return { or: keywords.flatMap((k) => [{ subject: k }, { body: k }]) };
}

/**
 * Keywords a caller named: ALL of them must hit, because "netflix rechnung"
 * means both words (#240).
 *
 * IMAP ANDs juxtaposed keys, but a query object holds one `or`, so the
 * conjunction of two OR-clauses is spelled by De Morgan — NOT (NOT a OR NOT b).
 * It is core IMAP4rev1, and a server that still will not run it throws, which
 * drops the search to the bounded local scan.
 */
function allKeywords(keywords: string[]): ImapSearchQuery {
  if (keywords.length === 1) return keywordClause(keywords[0]);
  return { not: { or: keywords.map((k) => ({ not: keywordClause(k) })) } };
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

  /**
   * Execute one provider-neutral search (#240).
   *
   * Keywords and the sender go to the server as SEARCH keys, which is the whole
   * point of lowering the manual attach path's query to this vocabulary: a
   * mailbox that can answer does the work itself. Two terms it cannot answer
   * are reported rather than dropped — attachment filenames (IMAP SEARCH has no
   * key for them) and the attachment flag (BODYSTRUCTURE is only visible after
   * a fetch, so the caller filters what it fetched).
   *
   * When the server rejects the keyword search — dovecot and friends do reject
   * BODY searches on some mailboxes — the fall-back is a bounded fetch of the
   * newest MAX_IMAP_SCAN_MESSAGES envelopes in the window, matched locally.
   * Bounded, because an unbounded walk of a large mailbox is a hang, and
   * narrower than the search it replaces: an envelope carries no body, so the
   * scan matches Subject and From where the server matched Subject and body.
   * Both the bound and the lost field are reported in `limitations`.
   */
  async search(opts: MailSearchOptions): Promise<MailSearchPage> {
    const client = await this.connect();
    const limitations: MailSearchLimitation[] = [];

    const window = {
      since: imapDate(opts.dateFrom),
      // IMAP `before` is exclusive on the date; +1 day makes dateTo inclusive.
      before: imapDate(addDays(opts.dateTo, 1)),
    };

    // The caller's keywords, or — when it names none — the invoice list this
    // integration may have opted out of pre-filtering with. An explicitly named
    // keyword is never dropped for `keywordPrefilter`: that flag turns off an
    // optimisation, not the search the caller asked for.
    const named = opts.keywords !== undefined;
    const keywords =
      opts.keywords ?? (this.config.keywordPrefilter ? INVOICE_KEYWORDS : []);

    if (opts.filenames?.length) {
      limitations.push({
        constraint: "filenames",
        handling: "unsupported",
        detail:
          "IMAP SEARCH has no attachment-filename key, so the results are not narrowed by filename.",
      });
    }
    if (opts.hasAttachment !== false) {
      limitations.push({
        constraint: "hasAttachment",
        handling: "scanned",
        detail:
          "IMAP SEARCH cannot see attachments; messages are filtered on BODYSTRUCTURE after they are fetched.",
      });
    }

    const query: ImapSearchQuery = { ...window };
    if (keywords.length > 0) {
      Object.assign(query, named ? allKeywords(keywords) : anyKeyword(keywords));
    }
    if (opts.from) {
      query.from = opts.from;
    }

    let uids: number[];
    try {
      const found = await client.search(query, { uid: true });
      uids = (found || []).slice().sort((a, b) => b - a); // newest UID first
    } catch (error) {
      uids = await this.scanWindow(client, window, keywords, named, opts.from, limitations, error);
    }

    // Cursor = last UID of the previous page; continue strictly below it.
    const cursor = opts.pageToken ? Number(opts.pageToken) : undefined;
    const remaining =
      cursor !== undefined ? uids.filter((u) => u < cursor) : uids;

    const page = remaining.slice(0, opts.limit ?? MAX_EMAILS_PER_BATCH);
    const hasMore = remaining.length > page.length;

    return {
      messages: page.map((uid) => ({ id: String(uid) })),
      nextPageToken:
        hasMore && page.length > 0 ? String(page[page.length - 1]) : undefined,
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  }

  /**
   * Fall-back for a server that will not run the keyword search: list the
   * window by date alone, keep the newest MAX_IMAP_SCAN_MESSAGES UIDs, and
   * match Subject/From ourselves over their envelopes.
   *
   * Both halves of the bound are reported — the keywords were matched locally
   * rather than by the server, and, if the window held more messages than the
   * scan reached, that the window was not exhausted.
   */
  private async scanWindow(
    client: ImapFlow,
    window: { since: string; before: string },
    keywords: string[],
    matchAll: boolean,
    from: string | undefined,
    limitations: MailSearchLimitation[],
    cause: unknown
  ): Promise<number[]> {
    console.warn(
      "[ImapProvider] server-side keyword search failed, scanning the window:",
      cause
    );

    const found = await client.search(window, { uid: true });
    const inWindow = (found || []).slice().sort((a, b) => b - a);
    const scanned = inWindow.slice(0, MAX_IMAP_SCAN_MESSAGES);

    // Which key the server choked on is not knowable from the rejection, so
    // every key that was re-applied locally is reported — both of them when a
    // search names keywords AND a sender, which the single entry this replaced
    // used to hide.
    //
    // The local pass is NOT the server pass done here: the server searches
    // Subject or body (`keywordClause`), the scan can only read the envelope it
    // fetched, so it matches Subject or From. A mail whose keyword appears only
    // in the body was found before the fall-back and is not found by it. That
    // is a recall difference, so it is reported rather than left implied by the
    // scan bound.
    const scannedNote =
      `Server rejected the search keys; matched locally over the newest ` +
      `${scanned.length} messages in the window, against Subject and From only ` +
      `— a match that appears solely in a message body is not found this way.`;
    if (keywords.length > 0) {
      limitations.push({ constraint: "keywords", handling: "scanned", detail: scannedNote });
    }
    if (from) {
      limitations.push({ constraint: "from", handling: "scanned", detail: scannedNote });
    }
    if (inWindow.length > scanned.length) {
      limitations.push({
        constraint: "dateWindow",
        handling: "scanned",
        detail: `Window holds ${inWindow.length} messages; only the newest ${MAX_IMAP_SCAN_MESSAGES} were scanned.`,
      });
    }
    if (scanned.length === 0) return [];

    const needles = keywords.map((k) => k.toLowerCase());
    const sender = from?.toLowerCase();
    const matched: number[] = [];

    for await (const msg of client.fetch(
      scanned,
      { uid: true, envelope: true },
      { uid: true }
    )) {
      const uid = msg.uid;
      if (uid === undefined) continue;
      const subject = (msg.envelope?.subject || "").toLowerCase();
      const fromHeader = formatFrom(msg.envelope?.from).toLowerCase();
      // Same ALL/ANY split the server-side query makes: named keywords must all
      // hit, the invoice sweep needs one. NOT the same fields, though — the
      // server searches Subject or body, and an envelope fetch has no body to
      // search, so this matches Subject or From. Reported as a limitation.
      const hit = (k: string) => subject.includes(k) || fromHeader.includes(k);
      const keywordHit =
        needles.length === 0 || (matchAll ? needles.every(hit) : needles.some(hit));
      const senderHit = !sender || fromHeader.includes(sender);
      if (keywordHit && senderHit) matched.push(uid);
    }

    return matched.sort((a, b) => b - a);
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
