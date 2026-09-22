"use client";

import { useState, useCallback } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import { EmailMessage, EmailSearchParams, EmailAttachment } from "@/types/email-integration";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";
import type { MailSearchLimitation } from "@/functions/src/mail/provider";

// ============================================================================
// Cloud Function Types
// ============================================================================

interface SearchGmailRequest {
  integrationId: string;
  /** Provider-neutral search terms (#240). */
  keywords?: string[];
  from?: string;
  filenames?: string[];
  dateFrom?: string;
  dateTo?: string;
  hasAttachments?: boolean;
  limit?: number;
  pageToken?: string;
  expandThreads?: boolean;
}

interface GmailAttachmentResult {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  isLikelyReceipt: boolean;
  existingFileId?: string | null;
}

interface GmailMessageResult {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string | null;
  date: string;
  snippet: string;
  bodyText: string | null;
  attachments: GmailAttachmentResult[];
}

interface SearchGmailResponse {
  messages: GmailMessageResult[];
  nextPageToken?: string;
  totalEstimate?: number;
  /** Constraints the provider could not execute as asked (#240). */
  limitations?: MailSearchLimitation[];
}

const searchGmailFn = httpsCallable<SearchGmailRequest, SearchGmailResponse>(
  functions,
  "searchGmailCallable"
);

export interface UseGmailSearchResult {
  /** Search results */
  messages: EmailMessage[];
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Whether there are more results */
  hasMore: boolean;
  /** Search for emails */
  search: (params: Omit<EmailSearchParams, "integrationId">) => Promise<void>;
  /** Load more results */
  loadMore: () => Promise<void>;
  /** Clear search results */
  clear: () => void;
  /** Currently previewing attachment */
  previewAttachment: EmailAttachment | null;
  /** Set preview attachment */
  setPreviewAttachment: (attachment: EmailAttachment | null) => void;
  /** Get preview URL for attachment */
  getPreviewUrl: (attachment: EmailAttachment) => string;
  /** Save attachment to Files and optionally connect to transaction */
  saveAttachment: (
    attachment: EmailAttachment,
    transactionId?: string,
    subject?: string
  ) => Promise<{ fileId: string; fileName: string }>;
  /** Saving state */
  saving: boolean;
}

export function useGmailSearch(integrationId: string | null): UseGmailSearchResult {
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [lastParams, setLastParams] = useState<Omit<EmailSearchParams, "integrationId"> | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<EmailAttachment | null>(null);

  // Transform callable response to EmailMessage format
  const transformResponse = useCallback((messages: GmailMessageResult[]): EmailMessage[] => {
    if (!integrationId) return [];
    return messages.map((msg) => ({
      messageId: msg.messageId,
      threadId: msg.threadId,
      subject: msg.subject,
      from: msg.from,
      fromName: msg.fromName || undefined,
      date: new Date(msg.date),
      snippet: msg.snippet,
      bodyText: msg.bodyText || undefined,
      integrationId,
      attachments: msg.attachments.map((att) => ({
        attachmentId: att.attachmentId,
        messageId: msg.messageId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        isLikelyReceipt: att.isLikelyReceipt,
        existingFileId: att.existingFileId || undefined,
      })),
    }));
  }, [integrationId]);

  // Search for emails using Cloud Function
  const search = useCallback(
    async (params: Omit<EmailSearchParams, "integrationId">) => {
      if (!integrationId) {
        setError("No Gmail account selected");
        return;
      }

      setLoading(true);
      setError(null);
      setMessages([]);
      setNextPageToken(undefined);
      setLastParams(params);

      try {
        const result = await searchGmailFn({
          integrationId,
          keywords: params.keywords,
          filenames: params.filenames,
          dateFrom: params.dateFrom?.toISOString(),
          dateTo: params.dateTo?.toISOString(),
          from: params.from,
          hasAttachments: params.hasAttachment,
          limit: params.limit,
          expandThreads: params.expandThreads,
        });

        setMessages(transformResponse(result.data.messages));
        setNextPageToken(result.data.nextPageToken);
      } catch (err) {
        console.error("Gmail search error:", err);
        // Handle Firebase function errors
        if (err instanceof Error) {
          const message = err.message;
          if (message.includes("Re-authentication") || message.includes("expired")) {
            setError("Gmail session expired. Please reconnect your account.");
          } else {
            setError(message);
          }
        } else {
          setError("Search failed");
        }
      } finally {
        setLoading(false);
      }
    },
    [integrationId, transformResponse]
  );

  // Load more results using Cloud Function
  const loadMore = useCallback(async () => {
    if (!integrationId || !nextPageToken || !lastParams || loading) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await searchGmailFn({
        integrationId,
        keywords: lastParams.keywords,
        filenames: lastParams.filenames,
        dateFrom: lastParams.dateFrom?.toISOString(),
        dateTo: lastParams.dateTo?.toISOString(),
        from: lastParams.from,
        hasAttachments: lastParams.hasAttachment,
        limit: lastParams.limit,
        expandThreads: lastParams.expandThreads,
        pageToken: nextPageToken,
      });

      setMessages((prev) => [...prev, ...transformResponse(result.data.messages)]);
      setNextPageToken(result.data.nextPageToken);
    } catch (err) {
      console.error("Load more error:", err);
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }, [integrationId, nextPageToken, lastParams, loading, transformResponse]);

  // Clear results
  const clear = useCallback(() => {
    setMessages([]);
    setNextPageToken(undefined);
    setLastParams(null);
    setError(null);
    setPreviewAttachment(null);
  }, []);

  // Get preview URL for attachment
  const getPreviewUrl = useCallback(
    (attachment: EmailAttachment): string => {
      if (!integrationId) return "";
      const params = new URLSearchParams({
        integrationId,
        messageId: attachment.messageId,
        attachmentId: attachment.attachmentId,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
      });
      return `/api/gmail/attachment?${params.toString()}`;
    },
    [integrationId]
  );

  // Save attachment to Files
  const saveAttachment = useCallback(
    async (
      attachment: EmailAttachment,
      transactionId?: string,
      subject?: string
    ): Promise<{ fileId: string; fileName: string }> => {
      if (!integrationId) {
        throw new Error("No Gmail account selected");
      }

      setSaving(true);
      setError(null);

      try {
        const response = await fetchWithAuth("/api/gmail/attachment", {
          method: "POST",
          body: JSON.stringify({
            integrationId,
            messageId: attachment.messageId,
            attachmentId: attachment.attachmentId,
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            transactionId,
            gmailMessageSubject: subject,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to save attachment");
        }

        const data = await response.json();
        return {
          fileId: data.fileId,
          fileName: data.fileName,
        };
      } catch (err) {
        console.error("Save attachment error:", err);
        const message = err instanceof Error ? err.message : "Failed to save attachment";
        setError(message);
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [integrationId]
  );

  return {
    messages,
    loading,
    error,
    hasMore: !!nextPageToken,
    search,
    loadMore,
    clear,
    previewAttachment,
    setPreviewAttachment,
    getPreviewUrl,
    saveAttachment,
    saving,
  };
}
