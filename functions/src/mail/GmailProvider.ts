/**
 * Gmail implementation of MailProvider.
 *
 * Wraps the Gmail REST API (the former inline GmailApiClient in
 * gmail/gmailSyncQueue.ts) and owns Gmail's query dialect and payload parsing.
 * OAuth token acquisition/refresh stays in the queue worker; this class takes
 * an already-valid access token.
 */

import {
  MailAttachment,
  MailMessage,
  MailMessageRef,
  MailProvider,
  MailSearchOptions,
  MailSearchPage,
} from "./provider";
import { INVOICE_MIME_TYPES, MAX_EMAILS_PER_BATCH } from "./constants";
import { buildGmailQuery } from "./gmail-query";

// ============================================================================
// Constants (Gmail-specific)
// ============================================================================

const REQUEST_DELAY_MS = 200; // 1000 / GMAIL_REQUESTS_PER_SECOND

// ============================================================================
// Gmail wire types
// ============================================================================

interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    parts?: GmailPart[];
    body?: { attachmentId?: string; size?: number; data?: string };
    mimeType: string;
  };
}

interface GmailPart {
  partId: string;
  mimeType: string;
  filename: string;
  body: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

// ============================================================================
// Helpers (pure)
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatGmailDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * The Gmail `q` for one search: the caller's terms, then the date window.
 *
 * A search naming no terms compiles to the invoice sweep the sync worker has
 * always sent — the quoted keyword list, `has:attachment filename:pdf` — so
 * Sync's query is unchanged by the terms vocabulary (#240).
 */
function buildSearchQuery(opts: MailSearchOptions): string {
  const nextDay = new Date(opts.dateTo);
  nextDay.setDate(nextDay.getDate() + 1);

  // `before:` is exclusive, so the window ends on dateTo + 1 to stay inclusive.
  return `${buildGmailQuery(opts)} after:${formatGmailDate(opts.dateFrom)} before:${formatGmailDate(nextDay)}`;
}

function extractHeader(message: GmailMessage, headerName: string): string | null {
  const header = message.payload.headers.find(
    (h) => h.name.toLowerCase() === headerName.toLowerCase()
  );
  return header?.value || null;
}

function extractAttachments(message: GmailMessage): MailAttachment[] {
  const attachments: MailAttachment[] = [];

  function processPartsRecursively(parts: GmailPart[] | undefined): void {
    if (!parts) return;

    for (const part of parts) {
      // Check if this part is an invoice-type attachment
      if (
        part.body?.attachmentId &&
        part.filename &&
        INVOICE_MIME_TYPES.includes(part.mimeType)
      ) {
        attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body.size || 0,
        });
      }

      // Recurse into nested parts
      if (part.parts) {
        processPartsRecursively(part.parts);
      }
    }
  }

  processPartsRecursively(message.payload.parts);
  return attachments;
}

// ============================================================================
// Gmail API Client
// ============================================================================

class GmailApiClient {
  private accessToken: string;
  private lastRequestTime = 0;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await sleep(REQUEST_DELAY_MS - elapsed + Math.random() * 50);
    }
    this.lastRequestTime = Date.now();
  }

  async searchMessages(
    query: string,
    pageToken?: string,
    limit: number = MAX_EMAILS_PER_BATCH
  ): Promise<{ messages: Array<{ id: string }>; nextPageToken?: string }> {
    await this.waitForRateLimit();

    const params = new URLSearchParams({
      q: query,
      maxResults: String(limit),
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gmail search failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      messages: data.messages || [],
      nextPageToken: data.nextPageToken,
    };
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    await this.waitForRateLimit();

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Gmail get message failed: ${response.status}`);
    }

    return response.json();
  }

  async getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<Buffer> {
    await this.waitForRateLimit();

    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      }
    );

    if (!response.ok) {
      throw new Error(`Gmail get attachment failed: ${response.status}`);
    }

    const data = await response.json();
    // Gmail returns base64url-encoded data
    const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(base64, "base64");
  }
}

// ============================================================================
// Provider
// ============================================================================

export class GmailProvider implements MailProvider {
  private client: GmailApiClient;

  constructor(accessToken: string) {
    this.client = new GmailApiClient(accessToken);
  }

  /**
   * Gmail executes every term of the vocabulary server-side — keywords, sender,
   * filenames, the attachment flag — in the one request it already made, so no
   * search reports a limitation and none costs an extra round trip.
   */
  async search(opts: MailSearchOptions): Promise<MailSearchPage> {
    const query = buildSearchQuery(opts);
    const result = await this.client.searchMessages(
      query,
      opts.pageToken,
      opts.limit
    );
    return {
      messages: result.messages,
      nextPageToken: result.nextPageToken,
    };
  }

  async getMessage(ref: MailMessageRef): Promise<MailMessage> {
    const message = await this.client.getMessage(ref.id);
    return {
      id: message.id,
      messageId: extractHeader(message, "Message-ID"),
      from: extractHeader(message, "From") || "",
      subject: extractHeader(message, "Subject") || "",
      date: new Date(parseInt(message.internalDate, 10)),
      attachments: extractAttachments(message),
    };
  }

  async getAttachment(
    message: MailMessage,
    attachment: MailAttachment
  ): Promise<Buffer> {
    return this.client.getAttachment(message.id, attachment.attachmentId);
  }

  async close(): Promise<void> {
    // Gmail is stateless (per-request fetch); nothing to release.
  }
}
