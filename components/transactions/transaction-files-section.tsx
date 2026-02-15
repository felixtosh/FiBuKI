"use client";

import { useMemo, useEffect } from "react";
import { format } from "date-fns";
import {
  Loader2,
  ChevronRight,
  Tag,
  X,
  Sparkles,
  Check,
  WandSparkles,
  AlertTriangle,
  UserCheck,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Globe,
  Play,
  LogIn,
} from "lucide-react";
import { Transaction } from "@/types/transaction";
import { TaxFile } from "@/types/file";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConnectButton } from "@/components/ui/connect-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { NoReceiptCategoryPopover } from "./no-receipt-category-popover";
import { ReceiptLostDialog } from "./receipt-lost-dialog";
import { useTransactionFiles, useFiles } from "@/hooks/use-files";
import { convertCurrency } from "@/lib/currency";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
// Category suggestions now come from transaction.categorySuggestions (computed on backend)
import { cn, toDateSafe } from "@/lib/utils";
import Link from "next/link";
import { useState } from "react";

// Consistent field row component (matches transaction-details.tsx)
// Uses container queries to stack vertically when panel is narrow (<300px)
function FieldRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-4 min-w-0 field-row-responsive",
        className
      )}
    >
      <span className="text-sm text-muted-foreground shrink-0 w-32 field-row-label">
        {label}
      </span>
      <span className="text-sm flex-1 min-w-0 field-row-value">{children}</span>
    </div>
  );
}

interface TransactionFilesSectionProps {
  transaction: Transaction;
  /** Whether a precision search is in progress */
  isSearching?: boolean;
  /** Current search strategy label (e.g., "Searching emails...") */
  searchLabel?: string;
  /** Trigger a precision search */
  onTriggerSearch?: () => void;
  /** Open the connect file overlay (lifted to page level) */
  onOpenConnectFile?: () => void;
  /** Whether the connect overlay is currently open */
  isConnectFileOpen?: boolean;
  /** Browser learn mode handlers (optional — shown when extension installed + partner assigned) */
  learnMode?: {
    isLearning: boolean;
    actions: { step: number; actionType: string }[];
    pdfCount: number;
    isSaving: boolean;
    error: string | null;
    startLearn: (params: {
      partnerId: string;
      partnerName: string;
      transactionId?: string;
      startUrl?: string;
    }) => void;
  };
  /** Browser replay mode handlers (optional — shown when recipe exists) */
  replayMode?: {
    isReplaying: boolean;
    progress: { step: number; total: number; message: string } | null;
    error: string | null;
    startReplay: (params: {
      partnerId: string;
      partnerName: string;
      transactionId: string;
      recipe: import("@/types/partner").BrowserRecipe;
      transaction: Transaction;
    }) => void;
  };
  /** Browser recipes for this partner (if any) */
  partnerRecipes?: import("@/types/partner").BrowserRecipe[];
  /** Partner name for display (needed for learn mode) */
  partnerName?: string;
  /** Partner website URL for learn mode start page */
  partnerWebsite?: string;
  /** Whether the browser extension is installed */
  extensionInstalled?: boolean;
}

interface DifferenceLineProps {
  transactionAmount: number;
  transactionCurrency: string;
  transactionDate: Date;
  files: TaxFile[];
}

function DifferenceLine({ transactionAmount, transactionCurrency, transactionDate, files }: DifferenceLineProps) {
  // Calculate sum of file amounts (only files with extracted amounts), converting to transaction currency
  const filesWithAmounts = files.filter((f) => f.extractedAmount != null);
  const isExtracting = files.some((f) => !f.extractionComplete && !f.isNotInvoice);

  // Convert all file amounts to transaction currency using payment date
  let filesSum = 0;
  let conversionFailed = false;
  for (const file of filesWithAmounts) {
    if (file.extractedCurrency === transactionCurrency) {
      filesSum += file.extractedAmount!;
    } else {
      const conversion = convertCurrency(
        file.extractedAmount!,
        file.extractedCurrency || "EUR",
        transactionCurrency,
        transactionDate
      );
      if (conversion) {
        filesSum += conversion.amount;
      } else {
        conversionFailed = true;
      }
    }
  }

  const hasAllAmounts = filesWithAmounts.length === files.length && !conversionFailed;

  // Transaction amount is negative for expenses, positive for income
  // File amounts are always positive (invoice amounts)
  const absTransactionAmount = Math.abs(transactionAmount);
  const difference = absTransactionAmount - filesSum;
  const isMatched = Math.abs(difference) < 100; // Allow 1 EUR/USD tolerance

  // Don't show if extracting or no amounts yet
  if (isExtracting || filesWithAmounts.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center justify-between p-2 -mx-2 border-t">
      <span className="text-sm text-muted-foreground">Difference</span>
      {/* Right side with spacing to align with FileRow amounts (gap-2 + button + gap-2 + chevron) */}
      <div className="flex items-center gap-2 shrink-0">
        {!hasAllAmounts ? (
          <span className="text-muted-foreground text-xs">Missing amounts</span>
        ) : isMatched ? (
          <span className="tabular-nums font-medium text-amount-positive flex items-center gap-1 text-sm">
            {formatAmount(0, transactionCurrency)} <Check className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className={cn(
            "tabular-nums font-medium flex items-center gap-1 text-sm",
            difference > 0 ? "text-amount-negative" : "text-amber-600"
          )}>
            {difference > 0 ? "-" : "+"}{formatAmount(Math.abs(difference), transactionCurrency)}
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
        )}
        {/* Spacer to match FileRow's disconnect button + chevron width */}
        <div className="w-[52px]" />
      </div>
    </div>
  );
}

function formatAmount(
  amount: number | null | undefined,
  currency: string | null | undefined
) {
  if (amount == null) return null;
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency || "EUR",
  }).format(amount / 100);
}

interface FileRowProps {
  file: TaxFile;
  transactionCurrency: string;
  transactionDate: Date;
  onDisconnect: () => void;
  disconnecting: boolean;
}

function FileRow({ file, transactionCurrency, transactionDate, onDisconnect, disconnecting }: FileRowProps) {
  const isExtracting = !file.extractionComplete && !file.isNotInvoice;

  // Check if file currency differs from transaction currency
  const hasCurrencyMismatch =
    file.extractedAmount != null &&
    file.extractedCurrency &&
    file.extractedCurrency !== transactionCurrency;

  // Convert to transaction currency using payment date
  let convertedAmount: number | null = null;
  if (hasCurrencyMismatch) {
    const conversion = convertCurrency(
      file.extractedAmount!,
      file.extractedCurrency!,
      transactionCurrency,
      transactionDate
    );
    if (conversion) {
      convertedAmount = conversion.amount;
    }
  }

  return (
    <Link
      href={`/files?id=${file.id}`}
      className="flex items-center justify-between gap-2 p-2 -mx-2 rounded hover:bg-muted/50 transition-colors group overflow-hidden"
    >
      <div className="min-w-0 flex-1 overflow-hidden w-0">
        <p className="text-sm truncate">{file.fileName}</p>
        <p className="text-xs text-muted-foreground">
          {toDateSafe(file.extractedDate)
            ? format(toDateSafe(file.extractedDate)!, "MMM d, yyyy")
            : toDateSafe(file.uploadedAt)
              ? format(toDateSafe(file.uploadedAt)!, "MMM d, yyyy")
              : "—"}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isExtracting ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : file.extractedAmount != null && (
          <span className="text-sm font-medium tabular-nums text-foreground">
            {hasCurrencyMismatch && convertedAmount != null ? (
              <>
                ~{formatAmount(convertedAmount, transactionCurrency)}
                <span className="text-muted-foreground text-xs ml-1">
                  ({formatAmount(file.extractedAmount, file.extractedCurrency)})
                </span>
              </>
            ) : (
              formatAmount(file.extractedAmount, file.extractedCurrency)
            )}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDisconnect();
          }}
          disabled={disconnecting}
          className="p-1 rounded hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {disconnecting ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
          )}
        </button>
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Link>
  );
}

interface SuggestedFileRowProps {
  file: TaxFile;
  confidence: number;
  matchSources: string[];
  onConfirm: () => void;
  onDecline: () => void;
}

function SuggestedFileRow({
  file,
  confidence,
  matchSources,
  onConfirm,
  onDecline,
}: SuggestedFileRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 p-2 -mx-2 rounded bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30 group overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden w-0">
        <p className="text-sm truncate">{file.fileName}</p>
        <p className="text-xs text-muted-foreground">
          {toDateSafe(file.extractedDate)
            ? format(toDateSafe(file.extractedDate)!, "MMM d, yyyy")
            : toDateSafe(file.uploadedAt)
              ? format(toDateSafe(file.uploadedAt)!, "MMM d, yyyy")
              : "—"}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {file.extractedAmount != null && (
          <span className="text-sm font-medium tabular-nums text-foreground">
            {formatAmount(file.extractedAmount, file.extractedCurrency)}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={cn(
                "text-xs px-1.5 py-0 cursor-help",
                confidence >= 85
                  ? "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300"
                  : confidence >= 70
                  ? "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300"
                  : "bg-muted text-muted-foreground border-border"
              )}
            >
              {Math.round(confidence)}%
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[220px] text-xs">
            <div className="font-medium mb-1">Match signals</div>
            {matchSources.length > 0 ? (
              <div className="space-y-0.5">
                {matchSources.map((source, idx) => (
                  <div key={idx}>{source}</div>
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground">No specific signals</div>
            )}
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={onDecline}
          className="p-1 rounded hover:bg-destructive/10 transition-colors"
          title="Decline suggestion"
        >
          <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
          title="Connect file"
        >
          <Check className="h-4 w-4 text-muted-foreground hover:text-green-600" />
        </button>
      </div>
    </div>
  );
}

export function TransactionFilesSection({
  transaction,
  isSearching = false,
  searchLabel,
  onTriggerSearch,
  onOpenConnectFile,
  isConnectFileOpen = false,
  learnMode,
  replayMode,
  partnerRecipes,
  partnerName,
  partnerWebsite,
  extensionInstalled = false,
}: TransactionFilesSectionProps) {
  const [isReceiptLostDialogOpen, setIsReceiptLostDialogOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [showRejectedFiles, setShowRejectedFiles] = useState(false);
  const [unrejecting, setUnrejecting] = useState<string | null>(null);

  const { files, loading: filesLoading, connectFile, disconnectFile, unrejectFile } =
    useTransactionFiles(transaction.id);
  const { files: allFiles, loading: allFilesLoading, getFileById } = useFiles();
  const {
    categories,
    loading: categoriesLoading,
    assignToTransaction,
    removeFromTransaction,
    assignReceiptLost,
    getCategoryById,
  } = useNoReceiptCategories();

  // Clear state when transaction changes
  useEffect(() => {
    setDismissedSuggestions(new Set());
    setShowRejectedFiles(false);
  }, [transaction.id]);

  // Check if transaction has a no-receipt category assigned
  const hasCategory = !!transaction.noReceiptCategoryId;
  const assignedCategory = hasCategory
    ? getCategoryById(transaction.noReceiptCategoryId!)
    : null;

  // Check if transaction has files
  const hasFiles = files.length > 0;

  // Use stored category suggestions from backend (no client-side computation)
  const categorySuggestions = useMemo(() => {
    if (hasCategory || hasFiles) {
      return [];
    }
    // Suggestions are pre-computed by backend and stored on transaction
    return (transaction.categorySuggestions || []).slice(0, 3);
  }, [transaction.categorySuggestions, hasCategory, hasFiles]);

  // Note: Auto-assignment is now handled by backend in matchCategories Cloud Function
  // No client-side auto-assignment needed

  // Compute file suggestions - files that have this transaction in their transactionSuggestions
  const fileSuggestions = useMemo(() => {
    if (hasFiles || hasCategory || allFilesLoading) {
      return [];
    }
    const connectedFileIds = new Set(files.map(f => f.id));
    const rejectedIds = new Set(transaction.rejectedFileIds || []);
    return allFiles
      .filter(file => {
        // Skip already connected files (to this transaction)
        if (connectedFileIds.has(file.id)) return false;
        // Skip files already connected to ANY transaction (avoid suggesting files that are assigned elsewhere)
        if (file.transactionIds && file.transactionIds.length > 0) return false;
        // Skip dismissed suggestions
        if (dismissedSuggestions.has(file.id)) return false;
        // Skip rejected files (user manually removed them from this transaction)
        if (rejectedIds.has(file.id)) return false;
        // Check if file has this transaction in suggestions
        return file.transactionSuggestions?.some(
          s => s.transactionId === transaction.id
        );
      })
      .map(file => {
        const suggestion = file.transactionSuggestions?.find(
          s => s.transactionId === transaction.id
        );
        return {
          file,
          confidence: suggestion?.confidence || 0,
          matchSources: suggestion?.matchSources || [],
        };
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }, [allFiles, allFilesLoading, files, hasFiles, hasCategory, transaction.id, dismissedSuggestions]);

  // Get rejected files info
  const rejectedFiles = useMemo(() => {
    const rejectedIds = transaction.rejectedFileIds || [];
    if (rejectedIds.length === 0 || allFilesLoading) return [];

    return rejectedIds
      .map(id => getFileById(id))
      .filter((f): f is TaxFile => f !== undefined);
  }, [transaction.rejectedFileIds, allFilesLoading, getFileById]);

  const rejectedCount = transaction.rejectedFileIds?.length || 0;

  const handleConnectFile = async (fileId: string) => {
    await connectFile(fileId);
    // If connecting a file, remove any no-receipt category
    if (hasCategory) {
      await removeFromTransaction(transaction.id);
    }
  };

  const handleDismissSuggestion = (fileId: string) => {
    setDismissedSuggestions(prev => new Set([...prev, fileId]));
  };

  const handleDisconnectFile = async (fileId: string) => {
    setDisconnecting(fileId);
    try {
      // Pass reject=true to add to rejectedFileIds, preventing auto-reconnection
      await disconnectFile(fileId, true);
    } catch (error) {
      console.error("Failed to disconnect file:", error);
    } finally {
      setDisconnecting(null);
    }
  };

  const handleUnrejectFile = async (fileId: string) => {
    setUnrejecting(fileId);
    try {
      await unrejectFile(fileId);
      // Close the rejections panel if no more rejections
      if (rejectedCount <= 1) {
        setShowRejectedFiles(false);
      }
    } catch (error) {
      console.error("Failed to unreject file:", error);
    } finally {
      setUnrejecting(null);
    }
  };

  const handleReconnectRejectedFile = async (fileId: string) => {
    setUnrejecting(fileId);
    try {
      // First unreject, then connect
      await unrejectFile(fileId);
      await connectFile(fileId);
      // Close the panel after reconnecting
      if (rejectedCount <= 1) {
        setShowRejectedFiles(false);
      }
    } catch (error) {
      console.error("Failed to reconnect file:", error);
    } finally {
      setUnrejecting(null);
    }
  };

  const handleSelectCategory = async (categoryId: string) => {
    const category = getCategoryById(categoryId);
    if (category?.templateId === "receipt-lost") {
      // Open receipt lost dialog
      setIsReceiptLostDialogOpen(true);
    } else {
      await assignToTransaction(transaction.id, categoryId, "manual");
    }
  };

  const handleSelectSuggestion = async (categoryId: string, confidence: number) => {
    const category = getCategoryById(categoryId);
    if (category?.templateId === "receipt-lost") {
      setIsReceiptLostDialogOpen(true);
    } else {
      await assignToTransaction(transaction.id, categoryId, "suggestion", confidence);
    }
  };

  const handleReceiptLostSubmit = async (
    reason: string,
    description: string
  ) => {
    await assignReceiptLost(transaction.id, reason, description);
    setIsReceiptLostDialogOpen(false);
  };

  const handleRemoveCategory = async () => {
    await removeFromTransaction(transaction.id);
  };

  const loading = filesLoading || categoriesLoading;

  return (
    <TooltipProvider>
      <div className="space-y-3" data-onboarding="files-section">
        {/* Section Header with Search and History Buttons */}
        <div className="flex items-center justify-between relative z-10">
          <h3 className="text-sm font-medium">File</h3>
          <div className="flex items-center gap-1">
            {/* Browser replay button — shown when recipe exists + extension installed + no files */}
            {!hasFiles && !transaction.noReceiptCategoryId && extensionInstalled && transaction.partnerId && replayMode && partnerRecipes && partnerRecipes.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 relative z-10 pointer-events-auto"
                    onClick={() => {
                      const recipe = partnerRecipes[0];
                      replayMode.startReplay({
                        partnerId: transaction.partnerId!,
                        partnerName: partnerName || transaction.partner || "",
                        transactionId: transaction.id,
                        recipe,
                        transaction,
                      });
                    }}
                    disabled={replayMode.isReplaying || (learnMode?.isLearning ?? false)}
                  >
                    {replayMode.isReplaying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {replayMode.isReplaying ? "Replaying..." : "Download invoice (replay recipe)"}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Browser learn mode button — shown when extension installed + partner assigned + no files/category */}
            {!hasFiles && !transaction.noReceiptCategoryId && extensionInstalled && transaction.partnerId && learnMode && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 relative z-10 pointer-events-auto"
                    onClick={() => {
                      const name = partnerName || transaction.partner || "";
                      // Smart start URL: partner website > Google search for partner > Google search for description
                      const startUrl = partnerWebsite
                        ? (partnerWebsite.startsWith("http") ? partnerWebsite : `https://${partnerWebsite}`)
                        : `https://www.google.com/search?q=${encodeURIComponent(name || transaction.description || "")}+invoice+login`;
                      learnMode.startLearn({
                        partnerId: transaction.partnerId!,
                        partnerName: name,
                        transactionId: transaction.id,
                        startUrl,
                      });
                    }}
                    disabled={learnMode.isLearning || learnMode.isSaving}
                  >
                    {learnMode.isLearning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Globe className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {learnMode.isLearning ? "Recording browser actions..." : "Find invoice in browser"}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Show search button for incomplete transactions (no files AND no category) */}
            {!hasFiles && !transaction.noReceiptCategoryId && onTriggerSearch && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 relative z-10 pointer-events-auto"
                    onClick={onTriggerSearch}
                    disabled={isSearching}
                  >
                    {isSearching ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <WandSparkles className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>AI search for receipt</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Searching indicator */}
        {isSearching && searchLabel && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{searchLabel}</span>
          </div>
        )}

        {/* Learn mode status indicator */}
        {learnMode?.isLearning && (
          <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 py-1">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            <span>
              Recording browser actions...{" "}
              <span className="text-muted-foreground">
                ({learnMode.actions.length} steps
                {learnMode.pdfCount > 0 && ` · ${learnMode.pdfCount} files`})
              </span>
            </span>
          </div>
        )}

        {/* Learn mode error */}
        {learnMode?.error && !learnMode.isLearning && !learnMode.isSaving && (
          <div className="text-sm text-destructive py-1">
            {learnMode.error}
          </div>
        )}

        {/* Learn mode saving indicator */}
        {learnMode?.isSaving && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Saving browser recipe...</span>
          </div>
        )}

        {/* Replay mode status indicator */}
        {replayMode?.isReplaying && (
          <div className={`flex items-center gap-2 text-sm py-1 ${
            replayMode.progress?.message?.includes("Login required")
              ? "text-amber-600 dark:text-amber-400"
              : "text-cyan-600 dark:text-cyan-400"
          }`}>
            {replayMode.progress?.message?.includes("Login required") ? (
              <LogIn className="h-3.5 w-3.5" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            <span>
              {replayMode.progress?.message || "Replaying recipe..."}
              {replayMode.progress && replayMode.progress.total > 0 && (
                <span className="text-muted-foreground">
                  {" "}({replayMode.progress.step}/{replayMode.progress.total})
                </span>
              )}
            </span>
          </div>
        )}

        {/* Replay mode error */}
        {replayMode?.error && !replayMode.isReplaying && (
          <div className="text-sm text-destructive py-1">
            {replayMode.error}
          </div>
        )}

        {/* Receipt Section */}
        <div className={cn("space-y-2", hasCategory && "opacity-50 pointer-events-none")}>
          {loading ? (
            <FieldRow label="Receipt">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </FieldRow>
          ) : hasFiles ? (
            <>
              <span className="text-sm text-muted-foreground">Receipt</span>
              <div className="space-y-0.5">
                {files.map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    transactionCurrency={transaction.currency}
                    transactionDate={toDateSafe(transaction.date) || new Date()}
                    onDisconnect={() => handleDisconnectFile(file.id)}
                    disconnecting={disconnecting === file.id}
                  />
                ))}
                {/* Add button after files */}
                <div className="pt-1 flex items-center gap-2">
                  <ConnectButton
                    onClick={onOpenConnectFile}
                    isOpen={isConnectFileOpen}
                    label="Add"
                    disabled={hasCategory || !onOpenConnectFile}
                  />
                  {rejectedCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowRejectedFiles(!showRejectedFiles)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      ({rejectedCount} rejected)
                      {showRejectedFiles ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                  )}
                </div>
                {/* Difference line - at bottom, aligned with file amounts */}
                <DifferenceLine
                  transactionAmount={transaction.amount}
                  transactionCurrency={transaction.currency}
                  transactionDate={toDateSafe(transaction.date) || new Date()}
                  files={files}
                />
                {/* Rejected files list */}
                {showRejectedFiles && rejectedFiles.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-dashed space-y-1">
                    <span className="text-xs text-muted-foreground">Rejected files</span>
                    {rejectedFiles.map((file) => (
                      <div
                        key={file.id}
                        className="flex items-center justify-between gap-2 p-2 -mx-2 rounded bg-muted/30"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm truncate text-muted-foreground">{file.fileName}</p>
                          <p className="text-xs text-muted-foreground/70">
                            {toDateSafe(file.extractedDate)
                              ? format(toDateSafe(file.extractedDate)!, "MMM d, yyyy")
                              : toDateSafe(file.uploadedAt)
                                ? format(toDateSafe(file.uploadedAt)!, "MMM d, yyyy")
                                : "—"}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => handleUnrejectFile(file.id)}
                                disabled={unrejecting === file.id}
                                className="p-1 rounded hover:bg-muted transition-colors"
                                title="Allow auto-matching again"
                              >
                                {unrejecting === file.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                ) : (
                                  <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                                )}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Remove from rejected</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => handleReconnectRejectedFile(file.id)}
                                disabled={unrejecting === file.id}
                                className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                                title="Reconnect file"
                              >
                                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground hover:text-green-600" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Reconnect file</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <FieldRow label="Receipt">
                <div className="flex items-center gap-2">
                  <ConnectButton
                    onClick={onOpenConnectFile}
                    isOpen={isConnectFileOpen}
                    disabled={hasCategory || !onOpenConnectFile}
                  />
                  {rejectedCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowRejectedFiles(!showRejectedFiles)}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      ({rejectedCount} rejected)
                      {showRejectedFiles ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                  )}
                </div>
              </FieldRow>
              {/* Rejected files list when no files connected */}
              {showRejectedFiles && rejectedFiles.length > 0 && (
                <div className="mt-1 pt-2 border-t border-dashed space-y-1">
                  <span className="text-xs text-muted-foreground">Rejected files</span>
                  {rejectedFiles.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between gap-2 p-2 -mx-2 rounded bg-muted/30"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm truncate text-muted-foreground">{file.fileName}</p>
                        <p className="text-xs text-muted-foreground/70">
                          {toDateSafe(file.extractedDate)
                            ? format(toDateSafe(file.extractedDate)!, "MMM d, yyyy")
                            : toDateSafe(file.uploadedAt)
                              ? format(toDateSafe(file.uploadedAt)!, "MMM d, yyyy")
                              : "—"}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => handleUnrejectFile(file.id)}
                              disabled={unrejecting === file.id}
                              className="p-1 rounded hover:bg-muted transition-colors"
                              title="Allow auto-matching again"
                            >
                              {unrejecting === file.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                              ) : (
                                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Remove from rejected</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => handleReconnectRejectedFile(file.id)}
                              disabled={unrejecting === file.id}
                              className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
                              title="Reconnect file"
                            >
                              <RotateCcw className="h-3.5 w-3.5 text-muted-foreground hover:text-green-600" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Reconnect file</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* File Suggestions - shown when no files and no category */}
        {!hasFiles && !hasCategory && fileSuggestions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-sm text-muted-foreground">Suggested files</span>
            </div>
            <div className="space-y-1">
              {fileSuggestions.map(({ file, confidence, matchSources }) => (
                <SuggestedFileRow
                  key={file.id}
                  file={file}
                  confidence={confidence}
                  matchSources={matchSources}
                  onConfirm={() => handleConnectFile(file.id)}
                  onDecline={() => handleDismissSuggestion(file.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* No Receipt Row */}
        <FieldRow
          label="No Receipt"
          className={cn(hasFiles && "opacity-50 pointer-events-none")}
        >
          {hasCategory && assignedCategory ? (
            <Link
              href={`/categories?id=${assignedCategory.id}`}
              className="inline-flex items-center h-7 px-3 gap-2 rounded-md border text-sm max-w-full min-w-0 bg-background border-input cursor-pointer hover:bg-accent"
            >
              <Tag className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="truncate">{assignedCategory.name}</span>
              {transaction.receiptLostEntry && (
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  ({transaction.receiptLostEntry.reason})
                </span>
              )}
              {/* Show manual checkmark or confidence percentage */}
              {transaction.noReceiptCategoryMatchedBy === "manual" ? (
                <span className="inline-flex items-center text-green-600 flex-shrink-0">
                  <UserCheck className="h-3 w-3" />
                </span>
              ) : transaction.noReceiptCategoryConfidence ? (
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {Math.round(transaction.noReceiptCategoryConfidence)}%
                </span>
              ) : null}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleRemoveCategory();
                }}
                className="flex-shrink-0 p-0.5 -mr-1 rounded hover:bg-destructive/10"
              >
                <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
              </button>
            </Link>
          ) : (
            <NoReceiptCategoryPopover
              categories={categories}
              transaction={transaction}
              onSelect={handleSelectCategory}
              disabled={hasFiles}
            />
          )}
        </FieldRow>

        {/* Category Suggestions - shown when no category assigned and no files */}
        {!hasCategory && !hasFiles && categorySuggestions.length > 0 && (
          <FieldRow label="Suggestions" className="mt-1">
            <div className="flex flex-wrap gap-1.5">
              {categorySuggestions.map((suggestion) => {
                const category = getCategoryById(suggestion.categoryId);
                if (!category) return null;
                return (
                  <button
                    key={suggestion.categoryId}
                    type="button"
                    onClick={() => handleSelectSuggestion(suggestion.categoryId, suggestion.confidence)}
                    className="inline-flex items-center h-7 px-3 gap-2 rounded-md border text-sm bg-info border-info-border text-info-foreground cursor-pointer hover:bg-info/80 transition-colors"
                  >
                    <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate max-w-[120px]">{category.name}</span>
                    <span className="text-xs opacity-75">{Math.round(suggestion.confidence)}%</span>
                  </button>
                );
              })}
            </div>
          </FieldRow>
        )}

        {/* Receipt lost dialog */}
        <ReceiptLostDialog
          open={isReceiptLostDialogOpen}
          onClose={() => setIsReceiptLostDialogOpen(false)}
          onConfirm={handleReceiptLostSubmit}
          transaction={transaction}
        />

      </div>
    </TooltipProvider>
  );
}
