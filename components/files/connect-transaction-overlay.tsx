"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { format } from "date-fns";
import {
  Search,
  Receipt,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectResultRow } from "@/components/ui/connect-result-row";
import { ContentOverlay } from "@/components/ui/content-overlay";
import { Transaction } from "@/types/transaction";
import { TaxFile, TransactionSuggestion } from "@/types/file";
import { useTransactions } from "@/hooks/use-transactions";
import { useTransactionMatching } from "@/hooks/use-transaction-matching";
import { cn, toDateSafe } from "@/lib/utils";
import {
  TransactionMatchResult,
  getMatchSourceLabel,
  isSuggestedMatch,
} from "@/types/transaction-matching";

interface ConnectTransactionOverlayProps {
  open: boolean;
  onClose: () => void;
  onSelect: (transactionIds: string[]) => Promise<void>;
  /** Transaction IDs that are already connected (to show as disabled) */
  connectedTransactionIds?: string[];
  /** File to connect transactions to */
  file?: TaxFile | null;
  /** Pre-computed transaction suggestions (fallback if server call fails) */
  suggestions?: TransactionSuggestion[];
}

export function ConnectTransactionOverlay({
  open,
  onClose,
  onSelect,
  connectedTransactionIds = [],
  file,
  suggestions = [],
}: ConnectTransactionOverlayProps) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewTransaction, setPreviewTransaction] = useState<Transaction | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Get all transactions for display (server provides scoring)
  const { transactions, loading: transactionsLoading } = useTransactions();

  // Memoize the fileInfo object to prevent unnecessary re-renders
  const extractedDateValue = toDateSafe(file?.extractedDate);
  const memoizedFileInfo = useMemo(() => {
    if (!file) return undefined;
    return {
      extractedAmount: file.extractedAmount ?? undefined,
      extractedDate: extractedDateValue?.toISOString() ?? undefined,
      extractedPartner: file.extractedPartner ?? undefined,
      extractedIban: file.extractedIban ?? undefined,
      extractedText: file.extractedText ?? undefined,
      partnerId: file.partnerId ?? undefined,
    };
  }, [
    file?.extractedAmount,
    extractedDateValue?.getTime(),
    file?.extractedPartner,
    file?.extractedIban,
    file?.extractedText,
    file?.partnerId,
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
    fileId: file?.id,
    fileInfo: memoizedFileInfo,
    excludeTransactionIds: memoizedExcludeIds,
    limit: 50,
  });

  // Track previous open state to detect overlay opening
  const prevOpenRef = useRef(false);
  const lastFileIdRef = useRef<string | null>(null);

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
      if (file?.id || memoizedFileInfo) {
        fetchMatches(search || undefined);
      }
    }, delay);

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [search, open, file?.id, memoizedFileInfo, fetchMatches]);

  // Reset state when overlay opens OR file changes
  useEffect(() => {
    if (!open) return;

    const fileChanged = file?.id !== lastFileIdRef.current;
    lastFileIdRef.current = file?.id || null;

    if (fileChanged) {
      setSearch("");
      setSelectedIds(new Set());
      setPreviewTransaction(null);
      setIsConnecting(false);
    }
  }, [open, file?.id]);

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
            date: toDateSafe(s.preview.date)?.toISOString() ?? new Date().toISOString(),
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

  const handleSearch = useCallback(() => {
    if (file?.id || memoizedFileInfo) {
      fetchMatches(search || undefined);
    }
  }, [file?.id, memoizedFileInfo, search, fetchMatches]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleSearch();
      }
    },
    [handleSearch]
  );

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

  // Subtitle
  const subtitle = file ? (
    <>
      {file.fileName}
      {extractedDateValue && (
        <> &middot; {format(extractedDateValue, "MMM d, yyyy")}</>
      )}
      {file.extractedAmount != null && (
        <>
          {" "}&middot;{" "}
          <span className={file.extractedAmount < 0 ? "text-amount-negative" : "text-amount-positive"}>
            {formatFileAmount(file.extractedAmount, file.extractedCurrency)}
          </span>
        </>
      )}
    </>
  ) : undefined;

  return (
    <TooltipProvider>
      <ContentOverlay
        open={open}
        onClose={onClose}
        title="Connect Transaction to File"
        subtitle={subtitle}
      >
        <div className="flex h-full">
          {/* Left sidebar: Search + Results */}
          <div className="w-[35%] min-w-[200px] max-w-[420px] shrink-0 border-r flex flex-col min-h-0 overflow-hidden">
            {/* Search section */}
            <div className="p-4 border-b space-y-3">
              <div className="relative flex gap-1.5">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or amount (e.g. 123,45)"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="pl-9"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleSearch}
                  disabled={loading}
                  className="shrink-0"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                </Button>
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
                <div className="p-8 text-sm text-muted-foreground text-center">
                  <Receipt className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p>{search ? "No transactions match your search" : "No transactions found"}</p>
                </div>
              ) : (
                <div className="p-2 space-y-1 overflow-hidden">
                  {filteredTransactions.map((transaction) => {
                    const isConnected = isTransactionConnected(transaction.id);
                    const isSelected = selectedIds.has(transaction.id);
                    const matchResult = matchMap.get(transaction.id);
                    const isSuggested = matchResult && isSuggestedMatch(matchResult);

                    return (
                      <ConnectResultRow
                        key={transaction.id}
                        id={transaction.id}
                        title={transaction.partner || transaction.name}
                        date={format(transaction.date.toDate(), "MMM d, yyyy")}
                        amount={formatAmount(transaction.amount, transaction.currency)}
                        amountType={transaction.amount < 0 ? "negative" : "positive"}
                        subtitle={transaction.name && transaction.partner ? transaction.name : undefined}
                        isSelected={isSelected}
                        isConnected={isConnected}
                        isHighlighted={isSuggested}
                        highlightVariant="suggestion"
                        confidence={matchResult?.confidence}
                        matchSignals={matchResult?.matchSources.map((s) => getMatchSourceLabel(s))}
                        onClick={() => toggleSelection(transaction)}
                      />
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Right panel: Preview + Actions */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
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

                {/* Footer with actions */}
                <div className="border-t p-4 flex justify-between items-center shrink-0">
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
                      {isConnecting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Connecting...
                        </>
                      ) : selectedIds.size === 0 ? (
                        "Select Transactions"
                      ) : (
                        `Connect ${selectedIds.size} Transaction${selectedIds.size !== 1 ? "s" : ""}`
                      )}
                    </Button>
                  </div>
                </div>
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
      </ContentOverlay>
    </TooltipProvider>
  );
}
