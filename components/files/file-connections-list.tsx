"use client";

import { useState, useEffect, useRef } from "react";
import { format } from "date-fns";
import { X, Loader2, ChevronRight, Check, AlertTriangle, Search, Sparkles, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TaxFile, TransactionSuggestion } from "@/types/file";
import { Transaction } from "@/types/transaction";
import { Badge } from "@/components/ui/badge";
import { ConnectButton } from "@/components/ui/connect-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, toDateSafe } from "@/lib/utils";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { convertCurrency } from "@/lib/currency";
import Link from "next/link";
import {
  getTransactionMatchConfidenceColor,
  getTransactionMatchSourceLabel,
} from "@/lib/matching/transaction-matcher";

// Consistent field row component (matches transaction-files-section and file-detail-panel)
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
        "flex items-baseline gap-4 field-row-responsive",
        className
      )}
    >
      <span className="text-sm text-muted-foreground shrink-0 w-28 field-row-label">
        {label}
      </span>
      <span className="text-sm field-row-value">{children}</span>
    </div>
  );
}

function formatAmount(amount: number, currency: string = "EUR") {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency || "EUR",
  }).format(amount / 100);
}

// Suggestion row for transaction suggestions (similar to transaction-files-section)
interface SuggestionRowProps {
  suggestion: TransactionSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
  disabled?: boolean;
}

function SuggestionRow({
  suggestion,
  onAccept,
  onDismiss,
  disabled,
}: SuggestionRowProps) {
  const { preview, confidence, matchSources } = suggestion;
  const txDate = preview.date?.toDate?.() || (preview.date as unknown as { seconds: number })?.seconds
    ? new Date((preview.date as unknown as { seconds: number }).seconds * 1000)
    : null;

  return (
    <div className="flex items-center gap-2 p-2 -mx-2 rounded bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm truncate flex-1">{preview.name}</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 text-xs px-1.5 py-0 cursor-help",
                  getTransactionMatchConfidenceColor(confidence)
                )}
              >
                {confidence}%
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[220px] text-xs">
              <div className="font-medium mb-1">Match signals</div>
              {matchSources.length > 0 ? (
                <div className="space-y-0.5">
                  {matchSources.map((source, idx) => (
                    <div key={idx}>{getTransactionMatchSourceLabel(source)}</div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No specific signals</div>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-muted-foreground">
            {txDate ? format(txDate, "MMM d, yyyy") : ""}
          </p>
          <span className={cn(
            "text-sm font-medium tabular-nums",
            preview.amount < 0 ? "text-amount-negative" : "text-amount-positive"
          )}>
            {/* Show transaction in its native currency - no conversion */}
            {formatAmount(preview.amount, preview.currency)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onDismiss}
          disabled={disabled}
          className="p-1 rounded hover:bg-destructive/10 transition-colors"
          title="Dismiss suggestion"
        >
          <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={disabled}
          className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
          title="Connect transaction"
        >
          <Check className="h-4 w-4 text-muted-foreground hover:text-green-600" />
        </button>
      </div>
    </div>
  );
}

interface TransactionRowProps {
  transaction: Transaction;
  fileCurrency: string;
  onRemove?: () => void;
  disabled?: boolean;
}

function TransactionRow({ transaction, fileCurrency, onRemove, disabled }: TransactionRowProps) {
  const txDate = toDateSafe(transaction.date);
  const hasCurrencyMismatch = transaction.currency !== fileCurrency;

  // Convert to file currency using transaction/payment date
  let convertedAmount: number | null = null;
  if (hasCurrencyMismatch && txDate) {
    const conversion = convertCurrency(
      Math.abs(transaction.amount),
      transaction.currency,
      fileCurrency,
      txDate
    );
    if (conversion) {
      convertedAmount = conversion.amount;
    }
  }

  return (
    <Link
      href={`/transactions?id=${transaction.id}`}
      className="flex items-center justify-between gap-2 p-2 -mx-2 rounded hover:bg-muted/50 transition-colors group overflow-hidden"
    >
      <div className="min-w-0 flex-1 overflow-hidden w-0">
        <p className="text-sm truncate">{transaction.name}</p>
        <p className="text-xs text-muted-foreground">
          {txDate ? format(txDate, "MMM d, yyyy") : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={cn(
          "text-sm font-medium tabular-nums",
          transaction.amount < 0 ? "text-amount-negative" : "text-amount-positive"
        )}>
          {hasCurrencyMismatch && convertedAmount != null ? (
            <>
              ~{formatAmount(transaction.amount < 0 ? -convertedAmount : convertedAmount, fileCurrency)}
              <span className="text-muted-foreground text-xs ml-1">
                ({formatAmount(transaction.amount, transaction.currency)})
              </span>
            </>
          ) : (
            formatAmount(transaction.amount, transaction.currency)
          )}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove();
            }}
            disabled={disabled}
            className="p-1 rounded hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
          </button>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Link>
  );
}

interface DifferenceLineProps {
  fileAmount: number;
  fileCurrency: string;
  transactions: Transaction[];
}

function DifferenceLine({ fileAmount, fileCurrency, transactions }: DifferenceLineProps) {
  // Determine the target currency for difference calculation (use first transaction's currency)
  // This ensures difference is shown in accounting/transaction currency
  const targetCurrency = transactions[0]?.currency || fileCurrency;

  // Convert file amount to target currency if needed
  let convertedFileAmount = fileAmount;
  let fileConversionFailed = false;
  if (fileCurrency !== targetCurrency && transactions[0]?.date) {
    const txDate = transactions[0].date.toDate();
    const conversion = convertCurrency(fileAmount, fileCurrency, targetCurrency, txDate);
    if (conversion) {
      convertedFileAmount = conversion.amount;
    } else {
      fileConversionFailed = true;
    }
  }

  // Sum transaction amounts in target currency
  let transactionsSum = 0;
  let txConversionFailed = false;

  for (const tx of transactions) {
    const txDate = toDateSafe(tx.date);
    if (tx.currency === targetCurrency) {
      transactionsSum += Math.abs(tx.amount);
    } else if (txDate) {
      const conversion = convertCurrency(
        Math.abs(tx.amount),
        tx.currency,
        targetCurrency,
        txDate
      );
      if (conversion) {
        transactionsSum += conversion.amount;
      } else {
        txConversionFailed = true;
      }
    } else {
      txConversionFailed = true;
    }
  }

  const hasAllAmounts = !fileConversionFailed && !txConversionFailed;
  const difference = convertedFileAmount - transactionsSum;
  const isMatched = Math.abs(difference) < 100; // Allow 1 EUR/USD tolerance
  const wasConverted = fileCurrency !== targetCurrency;

  if (transactions.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center justify-between p-2 -mx-2 border-t">
      <span className="text-sm text-muted-foreground">Difference</span>
      <div className="flex items-center gap-2 shrink-0">
        {!hasAllAmounts ? (
          <span className="text-muted-foreground text-xs">Missing amounts</span>
        ) : isMatched ? (
          <span className="tabular-nums font-medium text-amount-positive flex items-center gap-1 text-sm">
            {formatAmount(0, targetCurrency)} <Check className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className={cn(
            "tabular-nums font-medium flex items-center gap-1 text-sm",
            difference > 0 ? "text-amount-negative" : "text-amber-600"
          )}>
            {wasConverted ? "~" : ""}{difference > 0 ? "-" : "+"}{formatAmount(Math.abs(difference), targetCurrency)}
            <AlertTriangle className="h-3.5 w-3.5" />
          </span>
        )}
        {/* Spacer to align with TransactionRow's remove button + chevron */}
        <div className="w-[28px]" />
      </div>
    </div>
  );
}

interface FileConnectionsListProps {
  file: TaxFile;
  onDisconnect?: (transactionId: string) => Promise<void>;
  onConnectClick?: () => void;
  /** Whether the connect overlay is currently open */
  isConnectOpen?: boolean;
  /** Transaction suggestions for this file */
  suggestions?: TransactionSuggestion[];
  /** Accept a transaction suggestion */
  onAcceptSuggestion?: (suggestion: TransactionSuggestion) => Promise<void>;
  /** Dismiss a transaction suggestion */
  onDismissSuggestion?: (transactionId: string) => Promise<void>;
  /** Trigger re-matching for transaction suggestions */
  onTriggerRematch?: () => Promise<void>;
  /** Whether re-matching is in progress */
  isRematching?: boolean;
  /** Trigger AI-powered transaction search */
  onAiSearch?: () => void;
  /** Whether AI search is in progress */
  isAiSearching?: boolean;
}

export function FileConnectionsList({
  file,
  onDisconnect,
  onConnectClick,
  isConnectOpen = false,
  suggestions = [],
  onAcceptSuggestion,
  onDismissSuggestion,
  onTriggerRematch,
  isRematching = false,
  onAiSearch,
  isAiSearching = false,
}: FileConnectionsListProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  // Track previous file ID to detect actual file changes vs. data updates
  const prevFileIdRef = useRef<string | null>(null);

  // Fetch connected transactions
  useEffect(() => {
    const isFileChange = prevFileIdRef.current !== file.id;
    prevFileIdRef.current = file.id;

    if (file.transactionIds.length === 0) {
      setTransactions([]);
      setLoading(false);
      return;
    }

    // Only show loading on initial load or when switching files
    // Don't show loading for realtime updates (prevents flicker during processing)
    if (isFileChange) {
      setLoading(true);
    }

    const q = query(
      collection(db, "transactions"),
      where("fileIds", "array-contains", file.id)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as Transaction[];
        setTransactions(data);
        setLoading(false);
      },
      (error) => {
        console.error("Error fetching connected transactions:", error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [file.id, file.transactionIds.length]);

  const handleDisconnect = async (transactionId: string) => {
    if (!onDisconnect) return;
    setDisconnecting(transactionId);
    try {
      await onDisconnect(transactionId);
    } catch (error) {
      console.error("Failed to disconnect transaction:", error);
    } finally {
      setDisconnecting(null);
    }
  };

  const handleAcceptSuggestion = async (suggestion: TransactionSuggestion) => {
    if (!onAcceptSuggestion) return;
    setProcessingId(suggestion.transactionId);
    try {
      await onAcceptSuggestion(suggestion);
    } finally {
      setProcessingId(null);
    }
  };

  const handleDismissSuggestion = async (transactionId: string) => {
    if (!onDismissSuggestion) return;
    setProcessingId(transactionId);
    try {
      await onDismissSuggestion(transactionId);
    } finally {
      setProcessingId(null);
    }
  };

  const currency = file.extractedCurrency || transactions[0]?.currency || "EUR";

  // Filter out suggestions for already connected transactions
  const filteredSuggestions = suggestions.filter(
    (s) => !file.transactionIds?.includes(s.transactionId)
  );
  const hasSuggestions = filteredSuggestions.length > 0;

  const hasTransactions = transactions.length > 0;

  return (
    <TooltipProvider>
      <div className="space-y-2">
        {/* Header with title and action buttons */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Transaction</h3>
          <div className="flex items-center gap-1">
            {/* Search button to trigger AI transaction search */}
            {onAiSearch && !hasTransactions && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={onAiSearch}
                    disabled={isAiSearching}
                  >
                    {isAiSearching ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Search for matching transactions</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        ) : hasTransactions ? (
          <div className="space-y-0.5">
            {transactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                transaction={tx}
                fileCurrency={currency}
                onRemove={onDisconnect ? () => handleDisconnect(tx.id) : undefined}
                disabled={disconnecting === tx.id}
              />
            ))}
            {/* Add button after transactions */}
            <div className="pt-1">
              <ConnectButton
                onClick={onConnectClick}
                isOpen={isConnectOpen}
                label="Add"
              />
            </div>
            {/* Difference line at bottom */}
            {file.extractedAmount != null && (
              <DifferenceLine
                fileAmount={file.extractedAmount}
                fileCurrency={currency}
                transactions={transactions}
              />
            )}
          </div>
        ) : (
          <FieldRow label="Connect">
            <ConnectButton
              onClick={onConnectClick}
              isOpen={isConnectOpen}
            />
          </FieldRow>
        )}

        {/* Transaction Suggestions - shown when no transactions connected */}
        {!hasTransactions && hasSuggestions && (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span className="text-sm text-muted-foreground">Suggested transactions</span>
              <Badge variant="secondary" className="text-xs">
                {filteredSuggestions.length}
              </Badge>
            </div>
            <div className="space-y-1">
              {filteredSuggestions.map((suggestion) => (
                <SuggestionRow
                  key={suggestion.transactionId}
                  suggestion={suggestion}
                  onAccept={() => handleAcceptSuggestion(suggestion)}
                  onDismiss={() => handleDismissSuggestion(suggestion.transactionId)}
                  disabled={processingId === suggestion.transactionId}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
