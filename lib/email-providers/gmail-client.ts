import {
  EmailSearchResult,
  EmailMessage,
  EmailAttachment,
  AttachmentDownloadResult,
} from "@/types/email-integration";
import {
  EmailProviderClient,
  registerProviderFactory,
  isLikelyReceiptAttachment,
  buildGmailSearchQuery,
  classifyEmail,
} from "./interface";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** Max concurrent Gmail API requests to avoid 429 rate limit errors */
const MAX_CONCURRENT_REQUESTS = 5;

/**
 * Process items with limited concurrency to avoid rate limiting
 */
async function batchWithConcurrency<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = MAX_CONCURRENT_REQUESTS
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

/**
 * Gmail API client implementing the EmailProviderClient interface
 */
export class GmailClient implements EmailProviderClient {
  readonly provider = "gmail" as const;
  readonly integrationId: string;
  private accessToken: string;
  private refreshToken: string;
  private onTokenRefresh?: (newAccessToken: string, expiresAt: Date) => void;

  constructor(
    integrationId: string,
    accessToken: string,
    refreshToken: string,
    onTokenRefresh?: (newAccessToken: string, expiresAt: Date) => void
  ) {
    this.integrationId = integrationId;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.onTokenRefresh = onTokenRefresh;
  }

  /**
   * Make an authenticated request to the Gmail API
   */
  private async gmailFetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${GMAIL_API_BASE}/users/me${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("AUTH_EXPIRED");
      }
      const errorText = await response.text();
      throw new Error(`Gmail API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Search for emails matching the given criteria
   */
  async searchMessages(params: {
    query?: string;
    dateFrom?: Date;
    dateTo?: Date;
    hasAttachments?: boolean;
    from?: string;
    limit?: number;
    pageToken?: string;
    /** If true, fetch all messages in matching threads to get complete attachments */
    expandThreads?: boolean;
  }): Promise<EmailSearchResult> {
    // Build Gmail search query
    const searchQuery = buildGmailSearchQuery({
      query: params.query,
      from: params.from,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      hasAttachments: params.hasAttachments ?? true, // Default to only emails with attachments
    });

    // Search for message IDs
    const searchParams = new URLSearchParams({
      q: searchQuery,
      maxResults: String(params.limit || 20),
    });
    if (params.pageToken) {
      searchParams.set("pageToken", params.pageToken);
    }

    const searchResult = await this.gmailFetch<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(`/messages?${searchParams.toString()}`);

    if (!searchResult.messages || searchResult.messages.length === 0) {
      return {
        messages: [],
        nextPageToken: undefined,
        totalEstimate: 0,
      };
    }

    let validMessages: EmailMessage[];

    if (params.expandThreads) {
      // Get unique thread IDs and fetch full threads with concurrency limiting
      const threadIds = [...new Set(searchResult.messages.map((m) => m.threadId))];
      const threadMessages = await batchWithConcurrency(
        threadIds,
        (threadId) => this.getThreadMessages(threadId)
      );
      validMessages = threadMessages.flat();
    } else {
      // Fetch full message details with concurrency limiting
      const messages = await batchWithConcurrency(
        searchResult.messages,
        (msg) => this.getMessage(msg.id)
      );
      // Filter out null results (messages that couldn't be fetched)
      validMessages = messages.filter(
        (msg): msg is EmailMessage => msg !== null
      );
    }

    return {
      messages: validMessages,
      nextPageToken: searchResult.nextPageToken,
      totalEstimate: searchResult.resultSizeEstimate,
    };
  }

  /**
   * Get all messages in a thread
   */
  async getThreadMessages(threadId: string): Promise<EmailMessage[]> {
    try {
      const thread = await this.gmailFetch<{
        id: string;
        messages: GmailMessage[];
      }>(`/threads/${encodeURIComponent(threadId)}?format=full`);

      return thread.messages.map((msg) => this.parseMessage(msg));
    } catch (error) {
      console.error(`Failed to fetch thread ${threadId}:`, error);
      return [];
    }
  }

  /**
   * Get a single message by ID
   */
  private async getMessage(messageId: string): Promise<EmailMessage | null> {
    try {
      const message = await this.gmailFetch<GmailMessage>(
        `/messages/${encodeURIComponent(messageId)}?format=full`
      );

      return this.parseMessage(message);
    } catch (error) {
      console.error(`Failed to fetch message ${messageId}:`, error);
      return null;
    }
  }

  /**
   * Parse Gmail API message response into our EmailMessage format
   */
  private parseMessage(message: GmailMessage): EmailMessage {
    const headers = message.payload?.headers || [];

    // Extract headers
    const getHeader = (name: string): string => {
      const header = headers.find(
        (h) => h.name.toLowerCase() === name.toLowerCase()
      );
      return header?.value || "";
    };

    const subject = getHeader("Subject");
    const from = getHeader("From");
    const dateStr = getHeader("Date");

    // Parse sender
    const fromMatch = from.match(/(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)/);
    const fromName = fromMatch?.[1] || fromMatch?.[2]?.split("@")[0] || from;
    const fromEmail = fromMatch?.[2] || from;

    // Parse date
    let date: Date;
    try {
      date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        date = new Date(parseInt(message.internalDate));
      }
    } catch {
      date = new Date(parseInt(message.internalDate));
    }

    // Extract attachments
    const attachments = this.extractAttachments(message.payload, message.id);

    // Classify email based on snippet and subject (before downloading)
    const classification = classifyEmail(subject, message.snippet || "", attachments);

    return {
      messageId: message.id,
      threadId: message.threadId,
      integrationId: this.integrationId,
      subject,
      from: fromEmail,
      fromName,
      date,
      snippet: message.snippet || "",
      attachments,
      labels: message.labelIds,
      classification,
    };
  }

  /**
   * Recursively extract attachments from message payload
   */
  private extractAttachments(
    payload: GmailMessagePart | undefined,
    messageId: string
  ): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    if (!payload) return attachments;

    // Check if this part is an attachment
    if (payload.filename && payload.body?.attachmentId) {
      const mimeType = payload.mimeType || "application/octet-stream";
      attachments.push({
        attachmentId: payload.body.attachmentId,
        messageId,
        filename: payload.filename,
        mimeType,
        size: payload.body.size || 0,
        isLikelyReceipt: isLikelyReceiptAttachment(payload.filename, mimeType),
      });
    }

    // Recursively check child parts
    if (payload.parts) {
      for (const part of payload.parts) {
        attachments.push(...this.extractAttachments(part, messageId));
      }
    }

    return attachments;
  }

  /**
   * Download attachment data
   * @param messageId - Gmail message ID
   * @param attachmentId - Gmail attachment ID
   * @param metadata - Optional metadata (mimeType, filename) if already known
   */
  async getAttachmentData(
    messageId: string,
    attachmentId: string,
    metadata?: { mimeType?: string; filename?: string }
  ): Promise<AttachmentDownloadResult> {
    const encodedMessageId = encodeURIComponent(messageId);

    const downloadByToken = async (
      token: string
    ): Promise<{ data: Buffer; size: number }> => {
      const encodedToken = encodeURIComponent(token);
      const attachmentData = await this.gmailFetch<{ data: string; size: number }>(
        `/messages/${encodedMessageId}/attachments/${encodedToken}`
      );

      const data = Buffer.from(
        attachmentData.data.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      );

      return { data, size: data.length };
    };

    try {
      const downloaded = await downloadByToken(attachmentId);
      return {
        data: downloaded.data,
        mimeType: metadata?.mimeType || "application/octet-stream",
        filename: metadata?.filename || "attachment",
        size: downloaded.size,
      };
    } catch (error) {
      if (!this.isInvalidAttachmentTokenError(error)) {
        throw error;
      }

      // Gmail can occasionally invalidate attachment tokens; refresh message payload
      // and resolve the latest token by filename (or exact token if still present).
      const message = await this.gmailFetch<GmailMessage>(
        `/messages/${encodedMessageId}?format=full`
      );
      const attachmentParts = this.listAttachmentParts(message.payload);

      const filenameHint = metadata?.filename?.trim().toLowerCase();
      let resolvedPart = attachmentParts.find(
        (part) => part.attachmentId && part.attachmentId === attachmentId
      );

      if (!resolvedPart && filenameHint) {
        resolvedPart = attachmentParts
          .filter((part) => part.filename && part.filename.toLowerCase() === filenameHint)
          .sort((a, b) => (b.size || 0) - (a.size || 0))[0];
      }

      if (!resolvedPart) {
        const downloadableParts = attachmentParts
          .filter((part) => !!part.attachmentId || !!part.inlineData)
          .sort((a, b) => (b.size || 0) - (a.size || 0));
        if (downloadableParts.length === 1) {
          resolvedPart = downloadableParts[0];
        }
      }

      if (!resolvedPart) {
        throw new Error(
          `ATTACHMENT_TOKEN_INVALID: Attachment token is no longer valid for message ${messageId}`
        );
      }

      // Some small parts may be inlined in payload.body.data without attachmentId.
      if (!resolvedPart.attachmentId && resolvedPart.inlineData) {
        const inlined = Buffer.from(
          resolvedPart.inlineData.replace(/-/g, "+").replace(/_/g, "/"),
          "base64"
        );
        return {
          data: inlined,
          mimeType: resolvedPart.mimeType || metadata?.mimeType || "application/octet-stream",
          filename: resolvedPart.filename || metadata?.filename || "attachment",
          size: inlined.length,
        };
      }

      if (!resolvedPart.attachmentId) {
        throw new Error(
          `ATTACHMENT_TOKEN_INVALID: Attachment token is invalid and no replacement token was found for message ${messageId}`
        );
      }

      const refreshed = await downloadByToken(resolvedPart.attachmentId);
      return {
        data: refreshed.data,
        mimeType: resolvedPart.mimeType || metadata?.mimeType || "application/octet-stream",
        filename: resolvedPart.filename || metadata?.filename || "attachment",
        size: refreshed.size,
      };
    }
  }

  /**
   * Find an attachment part by ID in the message payload
   */
  private findAttachmentPart(
    payload: GmailMessagePart | undefined,
    attachmentId: string
  ): GmailMessagePart | null {
    if (!payload) return null;

    if (payload.body?.attachmentId === attachmentId) {
      return payload;
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        const found = this.findAttachmentPart(part, attachmentId);
        if (found) return found;
      }
    }

    return null;
  }

  private listAttachmentParts(
    payload: GmailMessagePart | undefined
  ): Array<{
    attachmentId?: string;
    filename: string;
    mimeType?: string;
    size?: number;
    inlineData?: string;
  }> {
    if (!payload) return [];

    const parts: Array<{
      attachmentId?: string;
      filename: string;
      mimeType?: string;
      size?: number;
      inlineData?: string;
    }> = [];

    if (payload.filename || payload.body?.attachmentId || payload.body?.data) {
      parts.push({
        attachmentId: payload.body?.attachmentId,
        filename: payload.filename || "",
        mimeType: payload.mimeType,
        size: payload.body?.size,
        inlineData: payload.body?.data,
      });
    }

    if (payload.parts) {
      for (const child of payload.parts) {
        parts.push(...this.listAttachmentParts(child));
      }
    }

    return parts;
  }

  private isInvalidAttachmentTokenError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const lower = error.message.toLowerCase();
    return (
      lower.includes("invalid attachment token") ||
      lower.includes("\"reason\": \"invalidargument\"") ||
      lower.includes("\"reason\":\"invalidargument\"")
    );
  }

  /**
   * Gmail doesn't provide direct preview URLs for attachments
   */
  async getAttachmentPreviewUrl(): Promise<string | null> {
    // Gmail requires downloading the full attachment
    // Preview is handled by downloading and displaying locally
    return null;
  }

  /**
   * Get the HTML and/or text body content of an email
   * @param messageId - Gmail message ID
   * @returns Object with htmlBody and textBody (either or both may be undefined)
   */
  async getEmailContent(messageId: string): Promise<{
    htmlBody?: string;
    textBody?: string;
  }> {
    const message = await this.gmailFetch<GmailMessage>(
      `/messages/${encodeURIComponent(messageId)}?format=full`
    );

    let htmlBody: string | undefined;
    let textBody: string | undefined;

    // Helper to decode base64url encoded content
    const decodeBody = (data: string): string => {
      const decoded = Buffer.from(
        data.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf-8");
      return decoded;
    };

    // Recursive function to find body parts
    const extractBodies = (part: GmailMessagePart | undefined): void => {
      if (!part) return;

      // Check if this part has body data
      if (part.body?.data) {
        if (part.mimeType === "text/html" && !htmlBody) {
          htmlBody = decodeBody(part.body.data);
        } else if (part.mimeType === "text/plain" && !textBody) {
          textBody = decodeBody(part.body.data);
        }
      }

      // Recursively check child parts
      if (part.parts) {
        for (const childPart of part.parts) {
          extractBodies(childPart);
        }
      }
    };

    extractBodies(message.payload);

    return { htmlBody, textBody };
  }

  /**
   * Validate that the current access token is still valid
   */
  async validateAuth(): Promise<boolean> {
    try {
      // Try to get profile info - simple API call to test auth
      await this.gmailFetch<{ emailAddress: string }>("/profile");
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "AUTH_EXPIRED") {
        return false;
      }
      throw error;
    }
  }

  /**
   * Attempt to refresh the access token via the server-side refresh endpoint
   */
  async refreshAuth(): Promise<boolean> {
    if (!this.refreshToken) {
      return false;
    }

    try {
      const response = await fetchWithAuth("/api/gmail/refresh", {
        method: "POST",
        body: JSON.stringify({ integrationId: this.integrationId }),
      });

      if (!response.ok) {
        console.error("Token refresh failed:", await response.text());
        return false;
      }

      const data = await response.json();

      // Update the access token
      this.accessToken = data.accessToken;

      // Notify callback if provided
      if (this.onTokenRefresh) {
        this.onTokenRefresh(data.accessToken, new Date(data.expiresAt));
      }

      return true;
    } catch (error) {
      console.error("Token refresh error:", error);
      return false;
    }
  }

  /**
   * Revoke OAuth access
   */
  async revokeAuth(): Promise<void> {
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${this.accessToken}`,
        { method: "POST" }
      );
    } catch {
      // Ignore revocation errors
    }
  }
}

/**
 * Gmail message types (from Gmail API)
 */
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload?: GmailMessagePart;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

// Register the Gmail client factory
registerProviderFactory(
  "gmail",
  (integrationId, accessToken, refreshToken) =>
    new GmailClient(integrationId, accessToken, refreshToken)
);

export default GmailClient;
