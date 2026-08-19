"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { subDays, addDays } from "date-fns";
import { TaxFile } from "@/types/file";
import { EmailMessage, EmailAttachment } from "@/types/email-integration";
import { isPdfOrImageAttachment } from "@/lib/email-providers/interface";
import { UserPartner } from "@/types/partner";
import { useFiles } from "./use-files";
import { useEmailIntegrations } from "./use-email-integrations";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";
import { useAuth } from "@/components/auth";
import { toDateSafe } from "@/lib/utils";

/**
 * Transaction info for smart search/ranking
 */
export interface TransactionInfo {
  id: string;
  date: Date;
  amount: number;
  currency: string;
  partner?: string;
  partnerId?: string;
}

/**
 * Unified search result - can be a local file or Gmail attachment
 */
export interface UnifiedSearchResult {
  /** Unique key for React rendering */
  id: string;
  /** Source type */
  type: "local" | "gmail";
  /** File/attachment name */
  filename: string;
  /** Date (extracted date for files, email date for Gmail) */
  date?: Date;
  /** Amount in cents (for files with extraction) */
  amount?: number;
  /** Currency code */
  currency?: string;
  /** Partner name (extracted for files, sender for Gmail) */
  partner?: string;
  /** Preview URL */
  previewUrl: string;
  /** MIME type */
  mimeType: string;
  /** Size in bytes */
  size: number;
  /** Whether this is likely a receipt */
  isLikelyReceipt: boolean;
  /** Fields that matched the search query */
  matchedFields?: string[];

  // For local files:
  fileId?: string;
  file?: TaxFile;

  // For Gmail attachments:
  integrationId?: string;
  messageId?: string;
  attachmentId?: string;
  emailSubject?: string;
  emailFrom?: string;

  // Ranking
  score: number;
  matchReasons: string[];
}

/**
 * Hook result
 */
export interface UseUnifiedFileSearchResult {
  /** Search results (sorted by score) */
  results: UnifiedSearchResult[];
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Run search */
  search: (query: string) => Promise<void>;
  /** Clear results */
  clear: () => void;
  /** Whether search has been run */
  hasSearched: boolean;
  /** Current search query */
  searchQuery: string;
  /** Set search query without searching */
  setSearchQuery: (query: string) => void;
}

/**
 * Convert a TaxFile to UnifiedSearchResult
 */
function fileToResult(file: TaxFile): Omit<UnifiedSearchResult, "score" | "matchReasons"> {
  return {
    id: `local-${file.id}`,
    type: "local",
    filename: file.fileName,
    date: toDateSafe(file.extractedDate) ?? undefined,
    amount: file.extractedAmount ?? undefined,
    currency: file.extractedCurrency ?? undefined,
    partner: file.extractedPartner ?? undefined,
    previewUrl: file.downloadUrl,
    mimeType: file.fileType,
    size: file.fileSize,
    isLikelyReceipt: true, // All uploaded files are assumed to be receipts
    fileId: file.id,
    file,
  };
}

/**
 * Convert a Gmail attachment to UnifiedSearchResult
 */
function attachmentToResult(
  attachment: EmailAttachment,
  message: EmailMessage,
  integrationId: string
): Omit<UnifiedSearchResult, "score" | "matchReasons"> {
  const params = new URLSearchParams({
    integrationId,
    messageId: attachment.messageId,
    attachmentId: attachment.attachmentId,
    mimeType: attachment.mimeType,
    filename: attachment.filename,
  });

  return {
    id: `gmail-${message.messageId}-${attachment.attachmentId}`,
    type: "gmail",
    filename: attachment.filename,
    date: message.date,
    partner: message.fromName || message.from,
    previewUrl: `/api/gmail/attachment?${params.toString()}`,
    mimeType: attachment.mimeType,
    size: attachment.size,
    isLikelyReceipt: attachment.isLikelyReceipt,
    integrationId,
    messageId: message.messageId,
    attachmentId: attachment.attachmentId,
    emailSubject: message.subject,
    emailFrom: message.from,
  };
}

export interface UnifiedFileSearchOptions {
  /** If true, only search local files (skip Gmail) */
  localOnly?: boolean;
  /** Optional date range filter - only applied if set */
  dateFrom?: Date;
  /** Optional date range filter - only applied if set */
  dateTo?: Date;
}

/**
 * Hook for unified file search across local files and Gmail
 * @param transactionInfo - Transaction to match against
 * @param partner - Optional partner for scoring
 * @param options - Search options
 */
export function useUnifiedFileSearch(
  transactionInfo: TransactionInfo,
  partner?: UserPartner | null,
  options?: UnifiedFileSearchOptions
): UseUnifiedFileSearchResult {
  const { localOnly, dateFrom, dateTo } = options || {};
  const { files, loading: filesLoading } = useFiles();
  const { integrations, loading: integrationsLoading, hasGmailIntegration } = useEmailIntegrations();
  const { user } = useAuth();

  const [searchQuery, setSearchQuery] = useState("");
  const [scoredResults, setScoredResults] = useState<UnifiedSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Track the latest search to prevent race conditions
  const searchIdRef = useRef(0);

  const gmailIntegrations = useMemo(
    () => integrations.filter((i) => i.provider === "gmail" && i.isActive),
    [integrations]
  );

  // Search a file against query and return matched fields
  const searchFile = useCallback((file: TaxFile, queryLower: string): string[] => {
    const matchedFields: string[] = [];

    // Filename
    if (file.fileName.toLowerCase().includes(queryLower)) {
      matchedFields.push("filename");
    }

    // Extracted partner
    if (file.extractedPartner?.toLowerCase().includes(queryLower)) {
      matchedFields.push("partner");
    }

    // Gmail subject
    if (file.gmailSubject?.toLowerCase().includes(queryLower)) {
      matchedFields.push("email subject");
    }

    // Gmail sender
    if (
      file.gmailSenderEmail?.toLowerCase().includes(queryLower) ||
      file.gmailSenderName?.toLowerCase().includes(queryLower)
    ) {
      matchedFields.push("email sender");
    }

    // Extracted VAT ID
    if (file.extractedVatId?.toLowerCase().includes(queryLower)) {
      matchedFields.push("VAT ID");
    }

    // Extracted IBAN
    if (file.extractedIban?.toLowerCase().includes(queryLower)) {
      matchedFields.push("IBAN");
    }

    // Extracted website
    if (file.extractedWebsite?.toLowerCase().includes(queryLower)) {
      matchedFields.push("website");
    }

    // OCR text (only if query is 4+ chars to avoid too many matches)
    if (queryLower.length >= 4 && file.extractedText?.toLowerCase().includes(queryLower)) {
      if (matchedFields.length === 0) {
        matchedFields.push("document text");
      }
    }

    return matchedFields;
  }, []);


  /**
   * Score results using the server-side scoring API for consistency
   */
  const scoreResultsWithApi = useCallback(
    async (
      localFiles: Array<{ file: TaxFile; matchedFields: string[] }>,
      gmailMessages: EmailMessage[],
      currentSearchId: number
    ): Promise<UnifiedSearchResult[]> => {
      // Build list of items to score
      const itemsToScore: Array<{
        baseResult: Omit<UnifiedSearchResult, "score" | "matchReasons">;
        matchedFields?: string[];
        apiInput: {
          key: string;
          filename: string;
          mimeType: string;
          emailSubject?: string | null;
          emailFrom?: string | null;
          emailSnippet?: string | null;
          emailDate?: string | null;
          integrationId?: string | null;
          fileExtractedAmount?: number | null;
          fileExtractedDate?: string | null;
          fileExtractedPartner?: string | null;
          filePartnerId?: string | null;
        };
      }> = [];

      // Add local files
      for (const { file, matchedFields } of localFiles) {
        const baseResult = fileToResult(file);
        itemsToScore.push({
          baseResult,
          matchedFields,
          apiInput: {
            key: baseResult.id,
            filename: file.fileName,
            mimeType: file.fileType,
            fileExtractedAmount: file.extractedAmount ?? null,
            fileExtractedDate: toDateSafe(file.extractedDate)?.toISOString() ?? null,
            fileExtractedPartner: file.extractedPartner ?? null,
            filePartnerId: file.partnerId ?? null,
            // Include Gmail metadata if the file came from Gmail
            emailSubject: file.gmailSubject ?? null,
            emailFrom: file.gmailSenderEmail ?? null,
          },
        });
      }

      // Add Gmail attachments (unless localOnly)
      if (!localOnly) {
        for (const message of gmailMessages) {
          for (const attachment of message.attachments) {
            // Only include PDFs and images
            if (!isPdfOrImageAttachment(attachment.mimeType, attachment.filename)) {
              continue;
            }

            const baseResult = attachmentToResult(attachment, message, message.integrationId);
            itemsToScore.push({
              baseResult,
              apiInput: {
                key: baseResult.id,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                emailSubject: message.subject ?? null,
                emailFrom: message.from ?? null,
                emailSnippet: message.snippet ?? null,
                emailDate: message.date?.toISOString() ?? null,
                integrationId: message.integrationId ?? null,
              },
            });
          }
        }
      }

      if (itemsToScore.length === 0) {
        return [];
      }

      try {
        // Get auth token for the API call
        const token = user ? await user.getIdToken() : null;

        const response = await fetch("/api/matching/score-files", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            attachments: itemsToScore.map((item) => item.apiInput),
            transaction: {
              amount: transactionInfo.amount,
              date: transactionInfo.date?.toISOString() ?? null,
              name: transactionInfo.partner ?? null,
              partner: transactionInfo.partner ?? null,
              partnerId: transactionInfo.partnerId ?? null,
            },
            partner: partner
              ? {
                  name: partner.name,
                  emailDomains: partner.emailDomains ?? null,
                  fileSourcePatterns: partner.fileSourcePatterns ?? null,
                }
              : null,
          }),
        });

        // Check if this search is still current (prevent race conditions)
        if (currentSearchId !== searchIdRef.current) {
          return [];
        }

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const result = await response.json();
        const scoreMap = new Map<string, { score: number; reasons: string[] }>();
        for (const scored of result.scores) {
          scoreMap.set(scored.key, { score: scored.score, reasons: scored.reasons });
        }

        // Combine base results with scores
        const allResults: UnifiedSearchResult[] = [];
        for (const item of itemsToScore) {
          const scoreData = scoreMap.get(item.baseResult.id) || { score: 0, reasons: [] };
          allResults.push({
            ...item.baseResult,
            score: scoreData.score,
            matchReasons: scoreData.reasons,
            matchedFields: item.matchedFields,
          });
        }

        // Sort by score descending
        return allResults.sort((a, b) => b.score - a.score);
      } catch (err) {
        console.error("[useUnifiedFileSearch] Scoring API error:", err);
        // Return results with score 0 on error (don't break the UI)
        return itemsToScore.map((item) => ({
          ...item.baseResult,
          score: 0,
          matchReasons: [],
          matchedFields: item.matchedFields,
        }));
      }
    },
    [user, transactionInfo, partner, localOnly]
  );

  // Search function
  const search = useCallback(
    async (query: string) => {
      // Increment search ID to track this search
      const currentSearchId = ++searchIdRef.current;

      setSearchQuery(query);
      setHasSearched(true);
      setError(null);
      setSearchLoading(true);

      try {
        // Get filtered local files
        let filteredFiles = files.filter((f) =>
          f.transactionIds.length === 0 && !f.isNotInvoice
        );

        // Filter by date range ONLY if explicitly set by user
        if (dateFrom || dateTo) {
          filteredFiles = filteredFiles.filter((f) => {
            if (!f.extractedDate) return true;
            const fileDate = f.extractedDate.toDate();
            if (dateFrom && fileDate < dateFrom) return false;
            if (dateTo && fileDate > dateTo) return false;
            return true;
          });
        }

        // Only include PDFs and images
        filteredFiles = filteredFiles.filter(
          (f) =>
            f.fileType === "application/pdf" ||
            f.fileType.startsWith("image/")
        );

        // Filter by search query and track matched fields
        let localFilesWithMatches: Array<{ file: TaxFile; matchedFields: string[] }>;
        if (query) {
          const queryLower = query.toLowerCase();
          localFilesWithMatches = filteredFiles
            .map((f) => ({ file: f, matchedFields: searchFile(f, queryLower) }))
            .filter((item) => item.matchedFields.length > 0);
        } else {
          localFilesWithMatches = filteredFiles.map((f) => ({ file: f, matchedFields: [] as string[] }));
        }

        // Search Gmail if enabled
        let gmailMessages: EmailMessage[] = [];
        if (!localOnly && hasGmailIntegration && gmailIntegrations.length > 0) {
          // Calculate date range for Gmail search
          const gmailDateFrom = transactionInfo.date
            ? subDays(transactionInfo.date, 30)
            : undefined;
          const gmailDateTo = transactionInfo.date
            ? addDays(transactionInfo.date, 7)
            : undefined;

          // Search all Gmail accounts in parallel
          const allMessages = await Promise.all(
            gmailIntegrations.map(async (integration) => {
              try {
                const response = await fetchWithAuth("/api/gmail/search", {
                  method: "POST",
                  body: JSON.stringify({
                    integrationId: integration.id,
                    query: query || undefined,
                    dateFrom: gmailDateFrom?.toISOString(),
                    dateTo: gmailDateTo?.toISOString(),
                    hasAttachments: true,
                    limit: 20,
                  }),
                });

                if (!response.ok) {
                  console.warn(`Gmail search failed for ${integration.email}`);
                  return [];
                }

                const data = await response.json();
                return (data.messages || []).map(
                  (msg: EmailMessage & { date: string }) => ({
                    ...msg,
                    date: new Date(msg.date),
                    integrationId: integration.id,
                  })
                );
              } catch (err) {
                console.warn(`Gmail search error for ${integration.email}:`, err);
                return [];
              }
            })
          );

          gmailMessages = allMessages.flat();
        }

        // Check if this search is still current
        if (currentSearchId !== searchIdRef.current) {
          return;
        }

        // Score all results using the server-side API
        const results = await scoreResultsWithApi(localFilesWithMatches, gmailMessages, currentSearchId);

        // Check again after scoring
        if (currentSearchId !== searchIdRef.current) {
          return;
        }

        setScoredResults(results);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Search failed");
      } finally {
        if (currentSearchId === searchIdRef.current) {
          setSearchLoading(false);
        }
      }
    },
    [files, gmailIntegrations, hasGmailIntegration, transactionInfo.date, localOnly, dateFrom, dateTo, searchFile, scoreResultsWithApi]
  );

  // Clear results
  const clear = useCallback(() => {
    setSearchQuery("");
    setScoredResults([]);
    setHasSearched(false);
    setError(null);
  }, []);

  return {
    results: scoredResults,
    loading: filesLoading || integrationsLoading || searchLoading,
    error,
    search,
    clear,
    hasSearched,
    searchQuery,
    setSearchQuery,
  };
}
