"use client";

import { useState, useEffect, useMemo } from "react";
import { format, subDays, addDays } from "date-fns";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";
import { termsFromQuery } from "@/functions/src/mail/search-terms";
import {
  Search,
  Mail,
  Paperclip,
  FileText,
  Image,
  Loader2,
  Download,
  AlertCircle,
  Calendar,
  Check,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { EmailMessage, EmailAttachment } from "@/types/email-integration";
import { isPdfOrImageAttachment } from "@/lib/email-providers/interface";
import { GmailAttachmentPreview } from "./gmail-attachment-preview";

interface EmailSearchPanelProps {
  /** Called when user selects an attachment to save and connect */
  onAttachmentSelect: (result: {
    fileId: string;
    fileName: string;
    /** The search query used to find the email (for pattern learning) */
    searchQuery?: string;
    /** The integration ID used (for pattern learning) */
    integrationId?: string;
  }) => Promise<void>;
  /** Transaction info for smart search suggestions */
  transactionInfo?: {
    date: Date;
    amount: number;
    currency: string;
    partner?: string;
    partnerId?: string;
  };
}

export function EmailSearchPanel({
  onAttachmentSelect,
  transactionInfo,
}: EmailSearchPanelProps) {
  const { integrations, loading: integrationsLoading, hasGmailIntegration } = useEmailIntegrations();
  const gmailIntegrations = useMemo(
    () => integrations.filter((i) => i.provider === "gmail"),
    [integrations]
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const [selectedAttachmentKey, setSelectedAttachmentKey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Generate smart search suggestion based on transaction
  const suggestedSearch = useMemo(() => {
    if (!transactionInfo?.partner) return "";
    const partnerName = transactionInfo.partner.toLowerCase();
    const cleanName = partnerName
      .replace(/\s*(gmbh|ag|kg|ohg|e\.v\.|inc\.|ltd\.|llc)\s*/gi, "")
      .trim();
    return cleanName;
  }, [transactionInfo]);

  // Flatten all attachments from all messages (only PDFs and images)
  const allAttachments = useMemo(() => {
    const attachments: Array<{
      key: string;
      attachment: EmailAttachment;
      message: EmailMessage;
      integrationId: string;
    }> = [];

    for (const message of messages) {
      for (const attachment of message.attachments) {
        if (isPdfOrImageAttachment(attachment.mimeType, attachment.filename)) {
          attachments.push({
            key: `${message.messageId}-${attachment.attachmentId}`,
            attachment,
            message,
            integrationId: message.integrationId,
          });
        }
      }
    }

    return attachments.sort((a, b) => {
      if (a.attachment.isLikelyReceipt && !b.attachment.isLikelyReceipt) return -1;
      if (!a.attachment.isLikelyReceipt && b.attachment.isLikelyReceipt) return 1;
      return b.message.date.getTime() - a.message.date.getTime();
    });
  }, [messages]);

  // Find selected attachment
  const selectedItem = useMemo(() => {
    if (!selectedAttachmentKey) return null;
    return allAttachments.find((a) => a.key === selectedAttachmentKey) || null;
  }, [allAttachments, selectedAttachmentKey]);

  // Initialize search query from suggestion and date range from transaction
  useEffect(() => {
    if (suggestedSearch && !searchQuery && !hasSearched) {
      setSearchQuery(suggestedSearch);
    }
  }, [suggestedSearch, searchQuery, hasSearched]);

  useEffect(() => {
    if (transactionInfo?.date && dateFrom === undefined && dateTo === undefined) {
      setDateFrom(subDays(transactionInfo.date, 30));
      setDateTo(addDays(transactionInfo.date, 7));
    }
  }, [transactionInfo, dateFrom, dateTo]);

  // Search all Gmail accounts in parallel
  const handleSearch = async (retryWithoutDates = false) => {
    if (gmailIntegrations.length === 0) return;

    setSearchLoading(true);
    setError(null);
    setHasSearched(true);

    const searchDateFrom = retryWithoutDates ? undefined : dateFrom;
    const searchDateTo = retryWithoutDates ? undefined : dateTo;

    try {
      // Search all integrations in parallel
      const results = await Promise.all(
        gmailIntegrations.map(async (integration) => {
          try {
            const response = await fetchWithAuth("/api/gmail/search", {
              method: "POST",
              body: JSON.stringify({
                integrationId: integration.id,
                // Neutral terms, not a Gmail query string (#240). Lowered word
                // by word rather than sent as one keyword: a whole typed line
                // as a single term would be matched as an exact phrase, which
                // finds less than the box finds today.
                ...termsFromQuery(searchQuery),
                dateFrom: searchDateFrom?.toISOString(),
                dateTo: searchDateTo?.toISOString(),
                hasAttachments: true,
                limit: 20,
              }),
            });

            if (!response.ok) {
              console.warn(`Search failed for ${integration.email}`);
              return [];
            }

            const data = await response.json();
            return (data.messages || []).map((msg: EmailMessage & { date: string }) => ({
              ...msg,
              date: new Date(msg.date),
              integrationId: integration.id,
            }));
          } catch (err) {
            console.warn(`Search error for ${integration.email}:`, err);
            return [];
          }
        })
      );

      // Merge all results
      const allMessages = results.flat();
      setMessages(allMessages);

      // Auto-clear dates if no results and dates were set
      if (allMessages.length === 0 && !retryWithoutDates && (dateFrom || dateTo)) {
        setDateFrom(undefined);
        setDateTo(undefined);
        // Retry search without dates
        await handleSearch(true);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearchLoading(false);
    }
  };

  // Auto-run search when component mounts with suggested query
  useEffect(() => {
    if (
      gmailIntegrations.length > 0 &&
      !hasSearched &&
      !integrationsLoading &&
      (suggestedSearch || transactionInfo?.partner)
    ) {
      handleSearch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmailIntegrations.length, integrationsLoading, hasSearched]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleSaveAttachment = async () => {
    if (!selectedItem) return;

    setIsSaving(true);
    try {
      const response = await fetchWithAuth("/api/gmail/attachment", {
        method: "POST",
        body: JSON.stringify({
          integrationId: selectedItem.integrationId,
          messageId: selectedItem.attachment.messageId,
          attachmentId: selectedItem.attachment.attachmentId,
          mimeType: selectedItem.attachment.mimeType,
          filename: selectedItem.attachment.filename,
          gmailMessageSubject: selectedItem.message.subject,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to save attachment");
      }

      const data = await response.json();
      await onAttachmentSelect({
        fileId: data.fileId,
        fileName: data.fileName,
        searchQuery: searchQuery || undefined,
        integrationId: selectedItem.integrationId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save attachment");
    } finally {
      setIsSaving(false);
    }
  };

  // No integrations connected
  if (integrationsLoading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        Loading integrations...
      </div>
    );
  }

  if (!hasGmailIntegration) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-8">
        <Mail className="h-12 w-12 mb-4 opacity-30" />
        <p className="text-center mb-4">
          No Gmail account connected.
          <br />
          Connect your Gmail to search for invoices.
        </p>
        <Button variant="outline" asChild>
          <a href="/integrations/gmail">Go to Integrations</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left: Search and results */}
      <div className="w-[420px] border-r flex flex-col">
        {/* Search */}
        <div className="p-4 border-b space-y-3">
          {/* Connected accounts info */}
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Mail className="h-3 w-3" />
            <span>
              Searching {gmailIntegrations.length} account{gmailIntegrations.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search emails..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-9"
            />
          </div>

          {/* Date range */}
          <div className="flex gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="flex-1 justify-start text-xs">
                  <Calendar className="h-3 w-3 mr-1" />
                  {dateFrom ? format(dateFrom, "MMM d, yyyy") : "From"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <CalendarComponent
                  mode="single"
                  selected={dateFrom}
                  onSelect={setDateFrom}
                  defaultMonth={dateFrom || transactionInfo?.date}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            {dateFrom && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setDateFrom(undefined)}
              >
                <X className="h-3 w-3" />
              </Button>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="flex-1 justify-start text-xs">
                  <Calendar className="h-3 w-3 mr-1" />
                  {dateTo ? format(dateTo, "MMM d, yyyy") : "To"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <CalendarComponent
                  mode="single"
                  selected={dateTo}
                  onSelect={setDateTo}
                  defaultMonth={dateTo || transactionInfo?.date}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            {dateTo && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => setDateTo(undefined)}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>

          <Button
            onClick={() => handleSearch()}
            disabled={searchLoading || gmailIntegrations.length === 0}
            className="w-full"
          >
            {searchLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Search className="h-4 w-4 mr-2" />
            )}
            Search
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="p-4 border-b">
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          </div>
        )}

        {/* Results - Flat list of attachments */}
        <ScrollArea className="flex-1">
          {allAttachments.length === 0 && !searchLoading ? (
            <div className="p-8 text-center text-muted-foreground">
              <Paperclip className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">
                {searchQuery || dateFrom || dateTo
                  ? "No attachments found"
                  : "Search for invoices in your Gmail"}
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {allAttachments.map((item) => (
                <AttachmentResultCard
                  key={item.key}
                  attachment={item.attachment}
                  message={item.message}
                  isSelected={selectedAttachmentKey === item.key}
                  onSelect={() => setSelectedAttachmentKey(item.key)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right: Preview */}
      <div className="flex-1 flex flex-col">
        {selectedItem ? (
          <>
            {/* Preview */}
            <div className="flex-1 overflow-hidden">
              <GmailAttachmentPreview
                integrationId={selectedItem.integrationId}
                messageId={selectedItem.attachment.messageId}
                attachmentId={selectedItem.attachment.attachmentId}
                mimeType={selectedItem.attachment.mimeType}
                filename={selectedItem.attachment.filename}
                fullSize
              />
            </div>
            {/* Info and action */}
            <div className="border-t p-4 space-y-3">
              <div>
                <p className="font-medium truncate">{selectedItem.attachment.filename}</p>
                <p className="text-sm text-muted-foreground truncate">
                  {selectedItem.message.fromName || selectedItem.message.from}
                </p>
                <p className="text-xs text-muted-foreground">
                  {format(selectedItem.message.date, "MMM d, yyyy")} · {Math.round(selectedItem.attachment.size / 1024)} KB
                  {selectedItem.attachment.isLikelyReceipt && (
                    <span className="ml-2 text-green-600">Likely receipt</span>
                  )}
                </p>
              </div>
              <Button
                onClick={handleSaveAttachment}
                disabled={isSaving}
                className="w-full"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Download className="h-4 w-4 mr-2" />
                )}
                Save & Connect
              </Button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FileText className="h-12 w-12 mx-auto mb-2 opacity-30" />
              <p>Select an attachment to preview</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface AttachmentResultCardProps {
  attachment: EmailAttachment;
  message: EmailMessage;
  isSelected: boolean;
  onSelect: () => void;
}

function AttachmentResultCard({ attachment, message, isSelected, onSelect }: AttachmentResultCardProps) {
  const isPdf =
    attachment.mimeType === "application/pdf" ||
    (attachment.mimeType === "application/octet-stream" &&
      attachment.filename.toLowerCase().endsWith(".pdf"));
  const sizeKb = Math.round(attachment.size / 1024);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full flex items-start gap-3 p-3 rounded-md transition-colors text-left overflow-hidden",
        isSelected && "bg-primary/10 ring-1 ring-primary",
        !isSelected && "hover:bg-muted"
      )}
    >
      <div className="h-10 w-10 rounded bg-muted flex items-center justify-center flex-shrink-0">
        {isPdf ? (
          <FileText className="h-5 w-5 text-red-500" />
        ) : (
          <Image className="h-5 w-5 text-blue-500" />
        )}
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-sm font-medium truncate">{attachment.filename}</p>
        <p className="text-xs text-muted-foreground truncate">
          {message.fromName || message.from}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {format(message.date, "MMM d, yyyy")}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{sizeKb} KB</span>
          {attachment.isLikelyReceipt && (
            <Badge variant="secondary" className="text-xs py-0 h-4 text-green-600">
              Likely
            </Badge>
          )}
        </div>
      </div>
      {isSelected && <Check className="h-4 w-4 text-primary flex-shrink-0 mt-1" />}
    </button>
  );
}
