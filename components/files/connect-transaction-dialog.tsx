"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { format } from "date-fns";
import { Search, Receipt, Check, Link2, Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Transaction } from "@/types/transaction";
import { TransactionSuggestion } from "@/types/file";
import { useTransactions } from "@/hooks/use-transactions";
import { useTransactionMatching } from "@/hooks/use-transaction-matching";
import { cn } from "@/lib/utils";
import {
  TransactionMatchResult,
  getMatchSourceLabel,
  isSuggestedMatch,
  TRANSACTION_MATCH_CONFIG,
} from "@/types/transaction-matching";

interface ConnectTransactionDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (transactionIds: string[]) => Promise<void>;
  /** Transaction IDs that are already connected (to show as disabled) */
  connectedTransactionIds?: string[];
  /** File ID for server-side matching */
  fileId?: string;
  /** File info for display (and for matching if fileId not provided) */
  fileInfo?: {
    fileName: string;
    extractedDate?: Date | null;
    extractedAmount?: number | null;
    extractedCurrency?: string | null;
    extractedPartner?: string | null;
    extractedIban?: string | null;
    extractedText?: string | null;
    partnerId?: string | null;
  };
  /** Pre-computed transaction suggestions (fallback if server call fails) */
  suggestions?: TransactionSuggestion[];
}

export function ConnectTransactionDialog({
  open,
  onClose,
  onSelect,
  connectedTransactionIds = [],
  fileId,
  fileInfo,
  suggestions = [],
}: ConnectTransactionDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewTransaction, setPreviewTransaction] = useState<Transaction | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Get all transactions for display (server provides scoring)
  const { transactions, loading: transactionsLoading } = useTransactions();

  // Memoize the fileInfo object to prevent unnecessary re-renders
  const memoizedFileInfo = useMemo(() => {
    if (!fileInfo) return undefined;
    return {
      extractedAmount: fileInfo.extractedAmount ?? undefined,
      extractedDate: fileInfo.extractedDate?.toISOString() ?? undefined,
      extractedPartner: fileInfo.extractedPartner ?? undefined,
      extractedIban: fileInfo.extractedIban ?? undefined,
      extractedText: fileInfo.extractedText ?? undefined,
      partnerId: fileInfo.partnerId ?? undefined,
    };
  }, [
    fileInfo?.extractedAmount,
    fileInfo?.extractedDate?.getTime(),
    fileInfo?.extractedPartner,
    fileInfo?.extractedIban,
    fileInfo?.extractedText,
    fileInfo?.partnerId,
  ]);

  // Memoize excludeTransactionIds to prevent unnecessary re-renders
  const memoizedExcludeIds = useMemo(
    () => connectedTransactionIds,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectedTransactionIds.join(",")]
  );

  // Server-side transaction matching
  const {
    matches: serverMatches,
    isLoading: matchesLoading,
    fetchMatches,
  } = useTransactionMatching({
    fileId,
    fileInfo: memoizedFileInfo,
    excludeTransactionIds: memoizedExcludeIds,
    limit: 50,
  });

  // Track previous open state to detect dialog opening
  const prevOpenRef = useRef(false);

  // Fetch matches: immediately on open, debounced on search change
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    const justOpened = !prevOpenRef.current;
    prevOpenRef.current = true;

    // Fetch immediately on open, debounce on search changes
    const delay = justOpened ? 0 : 300;

    searchDebounceRef.current = setTimeout(() => {
      if (fileId || memoizedFileInfo) {
        fetchMatches(search || undefined);
      }
    }, delay);

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [search, open, fileId, memoizedFileInfo, fetchMatches]);

  // Create a map of server match results by transaction ID
  const matchMap = useMemo(() => {
    const map = new Map<string, TransactionMatchResult>();
    for (const m of serverMatches) {
      map.set(m.transactionId, m);
    }
    // Also add fallback suggestions if server matches are empty
    if (serverMatches.length === 0 && suggestions.length > 0) {
      for (const s of suggestions) {
        map.set(s.transactionId, {
          transactionId: s.transactionId,
          confidence: s.confidence,
          matchSources: s.matchSources,
          breakdown: { amount: 0, date: 0, partner: 0, iban: 0, reference: 0, hint: 0 },
          preview: {
            date: s.preview.date.toDate().toISOString(),
            amount: s.preview.amount,
            currency: s.preview.currency,
            name: s.preview.name,
            partner: s.preview.partner,
          },
        });
      }
    }
    return map;
  }, [serverMatches, suggestions]);

  // Filter and sort transactions: when searching, only show matches
  const filteredTransactions = useMemo(() => {
    const trimmedSearch = search.trim().toLowerCase();

    // When searching, filter to only matching transactions
    const filtered = trimmedSearch
      ? transactions.filter((tx) => {
          // Include if server scored it
          if (matchMap.has(tx.id)) return true;
          // Include if local text match on name/partner/reference
          const name = (tx.name || "").toLowerCase();
          const partner = (tx.partner || "").toLowerCase();
          const reference = (tx.reference || "").toLowerCase();
          return (
            name.includes(trimmedSearch) ||
            partner.includes(trimmedSearch) ||
            reference.includes(trimmedSearch)
          );
        })
      : transactions;

    return filtered.sort((a, b) => {
      const aMatch = matchMap.get(a.id);
      const bMatch = matchMap.get(b.id);

      // Both have server scores - sort by confidence
      if (aMatch && bMatch) {
        return bMatch.confidence - aMatch.confidence;
      }

      // Only one has a server score - it goes first
      if (aMatch) return -1;
      if (bMatch) return 1;

      // Neither has a server score - sort by date (newest first)
      return b.date.toMillis() - a.date.toMillis();
    });
  }, [transactions, matchMap, search]);

  // Combined loading state
  const loading = transactionsLoading || matchesLoading;

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedIds(new Set());
      setPreviewTransaction(null);
      setIsConnecting(false);
    }
  }, [open]);

  const toggleSelection = (transaction: Transaction) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(transaction.id)) {
        next.delete(transaction.id);
      } else {
        next.add(transaction.id);
      }
      return next;
    });
    setPreviewTransaction(transaction);
  };

  const handleConnect = async () => {
    if (selectedIds.size === 0) return;

    setIsConnecting(true);
    try {
      await onSelect(Array.from(selectedIds));
      onClose();
    } catch (error) {
      console.error("Failed to connect transactions:", error);
    } finally {
      setIsConnecting(false);
    }
  };

  const formatAmount = (amount: number, currency: string) => {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency || "EUR",
    }).format(amount / 100);
  };

  const formatFileAmount = (amount: number | null | undefined, currency: string | null | undefined) => {
    if (amount == null) return null;
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency || "EUR",
    }).format(amount / 100);
  };

  const isTransactionConnected = (transactionId: string) =>
    connectedTransactionIds.includes(transactionId);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-[900px] h-[700px] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>Connect Transaction to File</DialogTitle>
          {fileInfo && (
            <p className="text-sm text-muted-foreground">
              {fileInfo.fileName}
              {fileInfo.extractedDate && (
                <> &middot; {format(fileInfo.extractedDate, "MMM d, yyyy")}</>
              )}
              {fileInfo.extractedAmount != null && (
                <>
                  {" "}
                  &middot;{" "}
                  <span className={fileInfo.extractedAmount < 0 ? "text-amount-negative" : "text-amount-positive"}>
                    {formatFileAmount(fileInfo.extractedAmount, fileInfo.extractedCurrency)}
                  </span>
                </>
              )}
            </p>
          )}
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {/* Left column: Transaction search and list */}
          <div className="w-[35%] min-w-[200px] max-w-[420px] border-r flex flex-col">
            {/* Search */}
            <div className="p-4 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or amount (e.g. 123,45)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            {/* Transaction list */}
            <ScrollArea className="flex-1">
              {loading ? (
                <div className="p-8 text-sm text-muted-foreground text-center">
                  <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin" />
                  {matchesLoading ? "Finding best matches..." : "Loading transactions..."}
                </div>
              ) : filteredTransactions.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground text-center">
                  {search ? "No transactions match your search" : "No transactions found"}
                </div>
              ) : (
                <TooltipProvider>
                  <div className="p-2 space-y-1">
                    {filteredTransactions.map((transaction) => {
                      const isConnected = isTransactionConnected(transaction.id);
                      const isSelected = selectedIds.has(transaction.id);
                      const isPreviewing = previewTransaction?.id === transaction.id;
                      const matchResult = matchMap.get(transaction.id);
                      const isSuggested = matchResult && isSuggestedMatch(matchResult);

                      return (
                        <button
                          key={transaction.id}
                          type="button"
                          disabled={isConnected}
                          onClick={() => toggleSelection(transaction)}
                          className={cn(
                            "w-full flex items-start gap-3 p-3 rounded-md text-left transition-colors overflow-hidden",
                            isSelected && "bg-primary/10",
                            isPreviewing && "ring-1 ring-primary",
                            !isSelected && !isConnected && "hover:bg-muted",
                            isConnected && "opacity-50 cursor-not-allowed",
                            isSuggested && !isSelected && !isConnected && "bg-amber-50 dark:bg-amber-950/20"
                          )}
                        >
                          {/* Checkbox */}
                          <div className={cn(
                            "flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center mt-0.5",
                            isSelected
                              ? "bg-primary border-primary"
                              : "border-muted-foreground/30",
                            isConnected && "bg-muted border-muted"
                          )}>
                            {(isSelected || isConnected) && (
                              <Check className={cn(
                                "h-3 w-3",
                                isSelected ? "text-primary-foreground" : "text-muted-foreground"
                              )} />
                            )}
                          </div>

                          {/* Transaction info */}
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-sm font-medium truncate flex-1 min-w-0">
                                {transaction.partner || transaction.name}
                              </p>
                              {isConnected && (
                                <Badge variant="secondary" className="text-xs">
                                  <Link2 className="h-3 w-3 mr-1" />
                                  Connected
                                </Badge>
                              )}
                              {isSuggested && matchResult && !isConnected && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge
                                      variant="outline"
                                      className="text-xs bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900 dark:text-amber-200 dark:border-amber-700"
                                    >
                                      <Sparkles className="h-3 w-3 mr-1" />
                                      {matchResult.confidence}%
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="text-xs">
                                    <p className="font-medium mb-1">Suggested match</p>
                                    <p className="text-muted-foreground">
                                      {matchResult.matchSources
                                        .map((s) => getMatchSourceLabel(s))
                                        .join(", ")}
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{format(transaction.date.toDate(), "MMM d, yyyy")}</span>
                              <span>&middot;</span>
                              <span
                                className={cn(
                                  "font-medium",
                                  transaction.amount < 0 ? "text-amount-negative" : "text-amount-positive"
                                )}
                              >
                                {formatAmount(transaction.amount, transaction.currency)}
                              </span>
                            </div>
                            {transaction.name && transaction.partner && (
                              <p className="text-xs text-muted-foreground truncate mt-0.5">
                                {transaction.name}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </TooltipProvider>
              )}
            </ScrollArea>
          </div>

          {/* Right column: Transaction preview */}
          <div className="flex-1 flex flex-col">
            {previewTransaction ? (
              <>
                {/* Transaction details */}
                <div className="flex-1 p-6 overflow-auto">
                  <h3 className="text-lg font-semibold mb-4">Transaction Details</h3>

                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">Date</p>
                        <p className="font-medium">
                          {format(previewTransaction.date.toDate(), "MMMM d, yyyy")}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Amount</p>
                        <p
                          className={cn(
                            "font-medium text-lg",
                            previewTransaction.amount < 0 ? "text-amount-negative" : "text-amount-positive"
                          )}
                        >
                          {formatAmount(previewTransaction.amount, previewTransaction.currency)}
                        </p>
                      </div>
                    </div>

                    {previewTransaction.partner && (
                      <div>
                        <p className="text-sm text-muted-foreground">Counterparty</p>
                        <p className="font-medium">{previewTransaction.partner}</p>
                      </div>
                    )}

                    <div>
                      <p className="text-sm text-muted-foreground">Description</p>
                      <p className="font-medium">{previewTransaction.name}</p>
                    </div>

                    {previewTransaction.reference && (
                      <div>
                        <p className="text-sm text-muted-foreground">Reference</p>
                        <p className="font-mono text-sm">{previewTransaction.reference}</p>
                      </div>
                    )}

                    {previewTransaction.partnerIban && (
                      <div>
                        <p className="text-sm text-muted-foreground">IBAN</p>
                        <p className="font-mono text-sm">{previewTransaction.partnerIban}</p>
                      </div>
                    )}

                    {/* Already connected files info */}
                    {previewTransaction.fileIds && previewTransaction.fileIds.length > 0 && (
                      <div className="pt-4 border-t">
                        <p className="text-sm text-muted-foreground mb-2">
                          Already connected files: {previewTransaction.fileIds.length}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Selection summary */}
                {selectedIds.size > 0 && (
                  <div className="border-t p-4 bg-muted/30">
                    <h4 className="font-medium text-sm mb-1">
                      {selectedIds.size} transaction{selectedIds.size !== 1 ? "s" : ""} selected
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Click transactions to add or remove from selection
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Receipt className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>Click transactions to select</p>
                  <p className="text-xs mt-1">You can select multiple</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t p-4 flex justify-between items-center">
          <div className="text-sm text-muted-foreground">
            {selectedIds.size > 0 && (
              <span>{selectedIds.size} selected</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleConnect}
              disabled={selectedIds.size === 0 || isConnecting}
            >
              {isConnecting
                ? "Connecting..."
                : selectedIds.size === 0
                ? "Select Transactions"
                : `Connect ${selectedIds.size} Transaction${selectedIds.size !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
