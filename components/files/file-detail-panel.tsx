"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import {
  Download,
  Trash2,
  Plus,
  Upload,
  Mail,
  RotateCcw,
  Loader2,
  ExternalLink,
  Info,
  Search,
  FileText,
} from "lucide-react";
import Link from "next/link";
import { TaxFile, TransactionSuggestion } from "@/types/file";
import { UserPartner, GlobalPartner, PartnerSuggestion } from "@/types/partner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { PanelHeader, FieldRow } from "@/components/ui/detail-panel-primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FilePreview } from "./file-preview";
import { FileExtractedInfo } from "./file-extracted-info";
import { FileConnectionsList } from "./file-connections-list";
import { AddPartnerDialog } from "@/components/partners/add-partner-dialog";
import { PartnerPill } from "@/components/partners/partner-pill";
import {
  OperationsContext,
  disconnectFileFromTransaction,
  connectFileToTransaction,
  assignPartnerToFile,
  removePartnerFromFile,
  acceptTransactionSuggestion,
  dismissTransactionSuggestion,
  retryFileExtraction,
  updateFileDirection,
  updateFileExtractedFields,
  refreshTransactionMatches,
  EditableExtractedFields,
} from "@/lib/operations";
import { InvoiceDirection } from "@/types/user-data";
import { useFilePartnerSuggestions, PartnerSuggestionWithDetails } from "@/hooks/use-partner-suggestions";
import { shouldAutoApply } from "@/lib/matching/partner-matcher";
import { db } from "@/lib/firebase/config";
import { cn, toDateSafe } from "@/lib/utils";
import { useAuth } from "@/components/auth";
import { useChat } from "@/components/chat/chat-provider";
import { InvoiceDetailPanel } from "@/components/invoicing/InvoiceDetailPanel";

// Helper to determine invoice type status for display
type InvoiceTypeStatus = 'unknown' | 'analyzing' | 'invoice' | 'not_invoice';

function getInvoiceTypeStatus(file: TaxFile): InvoiceTypeStatus {
  // Classification not done yet - show "Analyzing..."
  if (!file.classificationComplete) return 'analyzing';

  // Classification done - show result
  if (file.isNotInvoice === true) return 'not_invoice';
  if (file.isNotInvoice === false) return 'invoice';

  // Fallback for legacy files without classificationComplete
  const hasData = !!(file.extractedAmount || file.extractedDate || file.extractedPartner);
  if (hasData) return 'invoice';
  return 'unknown';
}

interface FileDetailPanelProps {
  file: TaxFile;
  onClose: () => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onDelete?: () => void;
  onRestore?: () => void;
  onMarkAsNotInvoice?: () => void;
  onUnmarkAsNotInvoice?: () => void;
  /** True when parsing is in progress after user marked file as invoice (skipping classification) */
  isParsing?: boolean;
  userPartners: UserPartner[];
  globalPartners: GlobalPartner[];
  onCreatePartner: (data: { name: string; aliases?: string[]; vatId?: string; ibans?: string[]; website?: string; country?: string; notes?: string }, options?: { skipAutoMatch?: boolean }) => Promise<string>;
  onOpenViewer?: () => void;
  viewerOpen?: boolean;
  /** Called when user clicks an extracted field to highlight it in the viewer */
  onHighlightField?: (text: string) => void;
  /** Called when user wants to open connect transaction overlay */
  onOpenConnectTransaction?: () => void;
  /** Whether connect transaction overlay is open (for button state) */
  isConnectTransactionOpen?: boolean;
}

export function FileDetailPanel(props: FileDetailPanelProps) {
  // Fibuki-generated invoice files fork to the invoice editor.
  if (props.file.invoiceId) {
    return (
      <InvoiceDetailPanel
        invoiceId={props.file.invoiceId}
        fileId={props.file.id}
        onClose={props.onClose}
      />
    );
  }
  return <FileDetailPanelInner {...props} />;
}

function FileDetailPanelInner({
  file,
  onClose,
  onNavigatePrevious,
  onNavigateNext,
  hasPrevious = false,
  hasNext = false,
  onDelete,
  onRestore,
  onMarkAsNotInvoice,
  onUnmarkAsNotInvoice,
  isParsing = false,
  userPartners,
  globalPartners,
  onCreatePartner,
  onOpenViewer,
  viewerOpen = false,
  onHighlightField,
  onOpenConnectTransaction,
  isConnectTransactionOpen = false,
}: FileDetailPanelProps) {
  const router = useRouter();
  const { userId } = useAuth();
  const [isAddPartnerOpen, setIsAddPartnerOpen] = useState(false);
  const [isAssigningPartner, setIsAssigningPartner] = useState(false);
  const [isRetryingExtraction, setIsRetryingExtraction] = useState(false);
  const [isUpdatingExtractedFields, setIsUpdatingExtractedFields] = useState(false);
  const [isRematchingTransactions, setIsRematchingTransactions] = useState(false);

  // Chat hook for agentic search (via workers)
  const { startFilePartnerSearch, startFileTransactionSearch, activeWandTargets, notifications } = useChat();
  const hasRunningWorkerNotification = notifications.some(
    (notification) =>
      notification.type === "worker_activity" &&
      notification.context.workerStatus === "running" &&
      notification.context.fileId === file.id
  );
  const isWandActive = activeWandTargets.has(file.id) || hasRunningWorkerNotification;

  const ctx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId]
  );

  // Find assigned partner from lists
  const assignedPartner = useMemo(() => {
    if (!file.partnerId) return null;
    if (file.partnerType === "user") {
      return userPartners.find((p) => p.id === file.partnerId) || null;
    }
    if (file.partnerType === "global") {
      return globalPartners.find((p) => p.id === file.partnerId) || null;
    }
    return null;
  }, [file.partnerId, file.partnerType, userPartners, globalPartners]);

  // Get partner suggestions based on extracted data
  const suggestions = useFilePartnerSuggestions(file, userPartners, globalPartners);

  const isGmailSource = file.sourceType?.startsWith("gmail");
  const isEmailInboundSource = file.sourceType?.startsWith("email_inbound");
  const isFibukiInvoice = file.sourceType === "fibuki_invoice";
  const sourceResultLabel = useMemo(() => {
    switch (file.sourceResultType) {
      case "gmail_attachment":
        return "Attachment";
      case "gmail_html_invoice":
        return "HTML Invoice";
      case "gmail_invoice_link":
        return "Invoice Link";
      case "local_file":
        return "Local File";
      default:
        return null;
    }
  }, [file.sourceResultType]);

  // Track which files have been auto-applied to prevent repeated auto-applies
  const autoAppliedRef = useRef<Set<string>>(new Set());

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleAssignPartner = useCallback(
    async (
      partnerId: string,
      partnerType: "user" | "global",
      matchedBy: "manual" | "suggestion" | "auto",
      confidence?: number
    ) => {
      setIsAssigningPartner(true);
      try {
        await assignPartnerToFile(ctx, file.id, partnerId, partnerType, matchedBy, confidence);
      } finally {
        setIsAssigningPartner(false);
      }
    },
    [ctx, file.id]
  );

  // Auto-apply high-confidence suggestions (>= 89%)
  // Uses "auto" matchedBy because this is automatic, not user-initiated
  useEffect(() => {
    if (assignedPartner || isAssigningPartner) return;
    if (autoAppliedRef.current.has(file.id)) return;

    const highConfidenceSuggestion = suggestions.find(
      (s) => shouldAutoApply(s.confidence)
    );

    if (highConfidenceSuggestion) {
      autoAppliedRef.current.add(file.id);
      handleAssignPartner(
        highConfidenceSuggestion.partnerId,
        highConfidenceSuggestion.partnerType,
        "auto",
        highConfidenceSuggestion.confidence
      ).catch((error) => {
        console.error("Failed to auto-apply partner to file:", error);
        autoAppliedRef.current.delete(file.id);
      });
    }
  }, [file.id, assignedPartner, suggestions, isAssigningPartner, handleAssignPartner]);

  const handleRemovePartner = useCallback(async () => {
    setIsAssigningPartner(true);
    try {
      // Add to autoAppliedRef BEFORE removal to prevent auto-apply from re-assigning
      autoAppliedRef.current.add(file.id);
      await removePartnerFromFile(ctx, file.id);
    } catch (error) {
      // If removal failed, allow auto-apply again
      autoAppliedRef.current.delete(file.id);
      throw error;
    } finally {
      setIsAssigningPartner(false);
    }
  }, [ctx, file.id]);

  const handleAddPartner = useCallback(
    async (data: { name: string; aliases?: string[]; vatId?: string; ibans?: string[]; website?: string; country?: string; notes?: string }) => {
      // Skip auto-match on partner create - we're manually assigning immediately after
      const partnerId = await onCreatePartner(data, { skipAutoMatch: true });
      await handleAssignPartner(partnerId, "user", "manual", 100);
      return partnerId;
    },
    [onCreatePartner, handleAssignPartner]
  );

  const handleSelectExistingPartner = useCallback(
    async (partnerId: string, partnerType: "user" | "global") => {
      await handleAssignPartner(partnerId, partnerType, "manual", 100);
    },
    [handleAssignPartner]
  );

  const handleSelectSuggestion = useCallback(
    async (suggestion: { partnerId: string; partnerType: "user" | "global"; confidence: number }) => {
      await handleAssignPartner(
        suggestion.partnerId,
        suggestion.partnerType,
        "suggestion",
        suggestion.confidence
      );
    },
    [handleAssignPartner]
  );

  const handleNavigateToPartner = useCallback(() => {
    if (file.partnerId) {
      router.push(`/partners?id=${file.partnerId}`);
    }
  }, [router, file.partnerId]);

  const handleDisconnect = useCallback(
    async (transactionId: string) => {
      try {
        await disconnectFileFromTransaction(ctx, file.id, transactionId);
      } catch (error) {
        console.error("Failed to disconnect file from transaction:", error);
      }
    },
    [ctx, file.id]
  );

  const handleConnectTransactions = useCallback(
    async (transactionIds: string[]) => {
      // Connect all selected transactions
      await Promise.all(
        transactionIds.map((transactionId) =>
          connectFileToTransaction(ctx, file.id, transactionId, "manual")
        )
      );
    },
    [ctx, file.id]
  );

  const handleAcceptTransactionSuggestion = useCallback(
    async (suggestion: TransactionSuggestion) => {
      await acceptTransactionSuggestion(
        ctx,
        file.id,
        suggestion.transactionId,
        suggestion.confidence,
        suggestion.matchSources
      );
    },
    [ctx, file.id]
  );

  const handleDismissTransactionSuggestion = useCallback(
    async (transactionId: string) => {
      await dismissTransactionSuggestion(ctx, file.id, transactionId);
    },
    [ctx, file.id]
  );

  const handleRetryExtraction = useCallback(async () => {
    setIsRetryingExtraction(true);
    try {
      await retryFileExtraction(ctx, file.id);
    } catch (error) {
      console.error("Failed to retry extraction:", error);
    } finally {
      setIsRetryingExtraction(false);
    }
  }, [ctx, file.id]);

  const handleDirectionChange = useCallback(async (direction: InvoiceDirection) => {
    try {
      await updateFileDirection(ctx, file.id, direction);
    } catch (error) {
      console.error("Failed to update invoice direction:", error);
    }
  }, [ctx, file.id]);

  const handleUpdateExtractedFields = useCallback(async (fields: EditableExtractedFields) => {
    setIsUpdatingExtractedFields(true);
    try {
      await updateFileExtractedFields(ctx, file.id, fields);
    } catch (error) {
      console.error("Failed to update extracted fields:", error);
    } finally {
      setIsUpdatingExtractedFields(false);
    }
  }, [ctx, file.id]);

  const handleTriggerTransactionRematch = useCallback(async () => {
    setIsRematchingTransactions(true);
    try {
      await refreshTransactionMatches(ctx, file.id);
    } catch (error) {
      console.error("Failed to refresh transaction matches:", error);
    } finally {
      setIsRematchingTransactions(false);
    }
  }, [ctx, file.id]);

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Header */}
        <PanelHeader
          title={file.fileName}
          onClose={onClose}
          onNavigatePrevious={onNavigatePrevious}
          onNavigateNext={onNavigateNext}
          hasPrevious={hasPrevious}
          hasNext={hasNext}
        />

        {/* Content */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">
            {/* Preview thumbnail - 25% width, click to toggle viewer */}
            <div className="flex gap-4 file-preview-section">
              <div className="w-1/4 flex-shrink-0 file-preview-thumb">
                <FilePreview
                  downloadUrl={file.downloadUrl}
                  fileType={file.fileType}
                  fileName={file.fileName}
                  onClick={onOpenViewer}
                  active={viewerOpen}
                />
                <p className="text-xs text-muted-foreground text-center mt-1">
                  {viewerOpen ? "Click to close" : "Click to view"}
                </p>
              </div>
              <div className="flex-1 space-y-2">
                {/* Quick file info - fixed label width for alignment */}
                <div className="text-sm space-y-1">
                  {/* Source & From at top */}
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Source</span>
                    <div className="flex-1 text-right file-meta-value">
                      {isGmailSource ? (
                        file.gmailIntegrationId ? (
                          <Link
                            href={`/integrations/${file.gmailIntegrationId}`}
                            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                          >
                            <Mail className="h-3 w-3" />
                            {file.gmailIntegrationEmail || "Gmail"}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            {file.gmailIntegrationEmail || "Gmail"}
                          </span>
                        )
                      ) : isEmailInboundSource ? (
                        <Link
                          href="/integrations/email-inbound"
                          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                        >
                          <Mail className="h-3 w-3" />
                          Email Forwarding
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : isFibukiInvoice ? (
                        <span className="inline-flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          Rechnungserstellung
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Upload className="h-3 w-3" />
                          Upload
                        </span>
                      )}
                    </div>
                  </div>
                  {isGmailSource && file.gmailSenderEmail && (
                    <div className="flex items-start gap-3 file-meta-row">
                      <span className="text-muted-foreground w-16 shrink-0 file-meta-label">From</span>
                      <span className="flex-1 text-right break-all file-meta-value">
                        {file.gmailSenderEmail}
                      </span>
                    </div>
                  )}
                  {isEmailInboundSource && file.inboundFrom && (
                    <div className="flex items-start gap-3 file-meta-row">
                      <span className="text-muted-foreground w-16 shrink-0 file-meta-label">From</span>
                      <span className="flex-1 text-right break-all file-meta-value">
                        {file.inboundFromName ? `${file.inboundFromName} <${file.inboundFrom}>` : file.inboundFrom}
                      </span>
                    </div>
                  )}
                  {isEmailInboundSource && file.inboundSubject && (
                    <div className="flex items-start gap-3 file-meta-row">
                      <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Subject</span>
                      <span className="flex-1 text-right break-all file-meta-value">
                        {file.inboundSubject}
                      </span>
                    </div>
                  )}
                  {file.sourceSearchPattern && (
                    <div className="flex items-start gap-3 file-meta-row">
                      <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Search</span>
                      <span className="flex-1 text-right break-all file-meta-value">
                        {file.sourceSearchPattern}
                      </span>
                    </div>
                  )}
                  {sourceResultLabel && (
                    <div className="flex items-start gap-3 file-meta-row">
                      <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Result</span>
                      <span className="flex-1 text-right file-meta-value">{sourceResultLabel}</span>
                    </div>
                  )}
                  {/* File metadata */}
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Uploaded</span>
                    <span className="flex-1 text-right file-meta-value">
                      {toDateSafe(file.uploadedAt) ? format(toDateSafe(file.uploadedAt)!, "MMM d, yyyy") : "—"}
                    </span>
                  </div>
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Size</span>
                    <span className="flex-1 text-right file-meta-value">{formatFileSize(file.fileSize)}</span>
                  </div>
                  {/* Invoice Type Classification */}
                  <div className="flex items-center gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">Type</span>
                    <div className="flex-1 flex justify-end file-meta-value">
                      {(() => {
                        const status = getInvoiceTypeStatus(file);
                        // Show "Analyzing..." only during classification phase
                        // When isParsing is true, user already confirmed it's an invoice
                        if (status === 'analyzing' && !isParsing) {
                          return (
                            <span className="flex items-center gap-1.5 text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Analyzing...
                            </span>
                          );
                        }
                        // When parsing after user override, show dropdown with "Invoice" selected
                        const displayStatus = isParsing ? 'invoice' : status;
                        return (
                          <Select
                            value={displayStatus === 'invoice' ? 'invoice' : displayStatus === 'not_invoice' ? 'not_invoice' : 'unknown'}
                            onValueChange={(value) => {
                              if (value === 'invoice' && onUnmarkAsNotInvoice) {
                                onUnmarkAsNotInvoice();
                              } else if (value === 'not_invoice' && onMarkAsNotInvoice) {
                                onMarkAsNotInvoice();
                              }
                            }}
                            disabled={isParsing}
                          >
                            <SelectTrigger className="h-7 w-[120px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="unknown" disabled>Unknown</SelectItem>
                              <SelectItem value="invoice">Invoice</SelectItem>
                              <SelectItem value="not_invoice">Not Invoice</SelectItem>
                            </SelectContent>
                          </Select>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Extracted Info */}
            <FileExtractedInfo
              file={file}
              onRetryExtraction={file.extractionError ? handleRetryExtraction : undefined}
              isRetrying={isRetryingExtraction}
              isParsing={isParsing}
              onFieldClick={onHighlightField}
              onDirectionChange={handleDirectionChange}
              onUpdate={handleUpdateExtractedFields}
              isUpdating={isUpdatingExtractedFields}
            />

            <Separator />

            {/* Partner Assignment Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Partner</h3>
                <div className="flex items-center gap-1">
                  {/* Search button to trigger AI partner search */}
                  {!assignedPartner && file.extractionComplete && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => startFilePartnerSearch(file.id)}
                      disabled={isWandActive}
                      title="Search for partner"
                    >
                      {isWandActive ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Search className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  {/* Debug info button */}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6">
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                  <PopoverContent className="w-80 text-xs" align="end">
                    <div className="space-y-2">
                      <p className="font-medium">Partner Match Debug</p>
                      <div className="space-y-1 text-muted-foreground">
                        <p><span className="font-medium text-foreground">Matched By:</span> {file.partnerMatchedBy || "none"}</p>
                        <p><span className="font-medium text-foreground">Confidence:</span> {file.partnerMatchConfidence ?? "—"}%</p>
                        <p><span className="font-medium text-foreground">Partner ID:</span> {file.partnerId || "none"}</p>
                        <p><span className="font-medium text-foreground">Partner Type:</span> {file.partnerType || "none"}</p>
                      </div>
                      {file.partnerSuggestions && file.partnerSuggestions.length > 0 && (
                        <>
                          <Separator className="my-2" />
                          <p className="font-medium">Suggestions ({file.partnerSuggestions.length})</p>
                          <div className="space-y-1.5">
                            {file.partnerSuggestions.map((s, i) => (
                              <div key={i} className="text-muted-foreground bg-muted/50 p-1.5 rounded">
                                <p><span className="font-medium text-foreground">#{i+1}:</span> {s.partnerId}</p>
                                <p>Confidence: {s.confidence}% | Source: {s.source}</p>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                      {file.extractedPartner && (
                        <>
                          <Separator className="my-2" />
                          <p className="font-medium">Extracted Data</p>
                          <div className="space-y-1 text-muted-foreground">
                            <p><span className="font-medium text-foreground">Partner:</span> {file.extractedPartner}</p>
                            {file.extractedVatId && <p><span className="font-medium text-foreground">VAT ID:</span> {file.extractedVatId}</p>}
                            {file.extractedIban && <p><span className="font-medium text-foreground">IBAN:</span> {file.extractedIban}</p>}
                            {file.invoiceDirection && <p><span className="font-medium text-foreground">Direction:</span> {file.invoiceDirection}</p>}
                            {file.matchedUserAccount && <p><span className="font-medium text-foreground">User Account:</span> {file.matchedUserAccount}</p>}
                          </div>
                        </>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
                </div>
              </div>

              <FieldRow label="Connect" labelWidth="w-28">
                {assignedPartner ? (
                  <PartnerPill
                    name={assignedPartner.name}
                    confidence={file.partnerMatchConfidence ?? undefined}
                    matchedBy={file.partnerMatchedBy}
                    partnerType={file.partnerType ?? undefined}
                    onClick={handleNavigateToPartner}
                    onRemove={handleRemovePartner}
                  />
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsAddPartnerOpen(true)}
                    className="h-7 px-3"
                    disabled={isAssigningPartner}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                )}
              </FieldRow>

              {/* Partner suggestions when no match */}
              {!assignedPartner && suggestions.length > 0 && (
                <FieldRow label="Suggestions" labelWidth="w-28">
                  <div className="flex flex-col gap-1.5">
                    {suggestions.map((suggestion) => (
                      <PartnerPill
                        key={suggestion.partnerId}
                        name={suggestion.partner.name}
                        confidence={suggestion.confidence}
                        variant="suggestion"
                        partnerType={suggestion.partnerType}
                        onClick={() => handleSelectSuggestion(suggestion)}
                        disabled={isAssigningPartner}
                      />
                    ))}
                  </div>
                </FieldRow>
              )}
            </div>

            <Separator />

            {/* Connected Transactions + Suggestions */}
            <FileConnectionsList
              file={file}
              onDisconnect={handleDisconnect}
              onConnectClick={onOpenConnectTransaction}
              isConnectOpen={isConnectTransactionOpen}
              suggestions={file.transactionSuggestions}
              onAcceptSuggestion={handleAcceptTransactionSuggestion}
              onDismissSuggestion={handleDismissTransactionSuggestion}
              onTriggerRematch={handleTriggerTransactionRematch}
              isRematching={isRematchingTransactions}
              onAiSearch={() =>
                startFileTransactionSearch(file.id, {
                  fileName: file.fileName,
                  amount: file.extractedAmount ?? undefined,
                  currency: file.extractedCurrency ?? undefined,
                  date: file.extractedDate?.toDate?.()?.toISOString().split("T")[0],
                  partner: file.extractedPartner ?? undefined,
                })
              }
              isAiSearching={isWandActive}
            />
          </div>
        </ScrollArea>

        {/* Footer actions */}
        <div className="p-4 border-t flex flex-col gap-2">
          {/* Primary row: Download + Delete/Restore */}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" asChild>
              <a href={file.downloadUrl} download={file.fileName}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </a>
            </Button>
            {file.deletedAt ? (
              // Show restore for deleted files
              onRestore && (
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={onRestore}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Restore
                </Button>
              )
            ) : (
              // Show delete for non-deleted files
              onDelete && (
                <Button
                  variant="outline"
                  className="flex-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={onDelete}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Add Partner Dialog */}
      <AddPartnerDialog
        open={isAddPartnerOpen}
        onClose={() => setIsAddPartnerOpen(false)}
        onAdd={handleAddPartner}
        onSelectPartner={handleSelectExistingPartner}
        onSelectSuggestion={handleSelectSuggestion}
        suggestions={suggestions}
        userPartners={userPartners}
        globalPartners={globalPartners}
        initialData={{
          name: file.extractedPartner || undefined,
          vatId: file.extractedVatId || undefined,
          ibans: file.extractedIban ? [file.extractedIban] : undefined,
          address: file.extractedAddress ? { street: file.extractedAddress, country: "" } : undefined,
        }}
      />
    </>
  );
}
