"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONNECT_DATE_WINDOW_OPTIONS,
  CONNECT_SORT_OPTIONS,
  ConnectControls,
  ConnectSortMode,
  filterConnectCandidates,
  rememberConnectControls,
  rememberedConnectControls,
  sortConnectCandidates,
} from "@/lib/matching/connect-candidate-order";
import { ContentOverlay } from "@/components/ui/content-overlay";
import { Transaction } from "@/types/transaction";
import { TaxFile, TransactionSuggestion } from "@/types/file";
import { useTransactions } from "@/hooks/use-transactions";
import { useFiles } from "@/hooks/use-files";
import {
  coverageFromConnectedFiles,
  otherConnectionCount,
  rowRemainder,
} from "@/lib/matching/connection-count";
import { useTransactionMatching } from "@/hooks/use-transaction-matching";
import { cn, toDateSafe } from "@/lib/utils";
import { matchesTransactionSearch } from "@/functions/src/matching/transactionSearch";
import {
  TransactionMatchResult,
  getMatchSourceLabel,
  isSuggestedMatch,
  heldBackKey,
  ineligibleKey,
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
  const t = useTranslations("connect");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewTransaction, setPreviewTransaction] = useState<Transaction | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Get all transactions for display (server provides scoring)
  const { transactions, loading: transactionsLoading } = useTransactions();

  // The Files already on each Transaction, for the rows the scorer did not
  // return a Coverage for (#243). Keyed by id; the File in hand is skipped at
  // lookup, as the scorer skips it.
  const { files: allFiles } = useFiles();
  const filesById = useMemo(() => {
    const map = new Map<string, TaxFile>();
    for (const f of allFiles) map.set(f.id, f);
    return map;
  }, [allFiles]);

  // The File's scoring fields in its own names, dates as ISO strings. The
  // server reads a stored File by id and ignores these; a File not stored
  // yet is read from them through the matcher's assembly (#613). Primitive
  // dependencies, so a re-extraction while the dialog is open refetches.
  const extractedDateValue = toDateSafe(file?.extractedDate);
  const extractedDateMs = extractedDateValue?.getTime();
  const dueDateMs = toDateSafe(file?.extractedDueDate)?.getTime();
  const debitDateMs = toDateSafe(file?.extractedDebitDate)?.getTime();
  const memoizedFileInfo = useMemo(() => {
    if (!file) return undefined;
    const iso = (ms: number | undefined) => (ms == null ? undefined : new Date(ms).toISOString());
    return {
      extractedAmount: file.extractedAmount ?? undefined,
      extractedTipAmount: file.extractedTipAmount ?? undefined,
      extractedCurrency: file.extractedCurrency ?? undefined,
      extractedDate: iso(extractedDateMs),
      extractedDueDate: iso(dueDateMs),
      extractedDebitDate: iso(debitDateMs),
      extractedPartner: file.extractedPartner ?? undefined,
      extractedIban: file.extractedIban ?? undefined,
      extractedText: file.extractedText ?? undefined,
      extractedInvoiceNumber: file.extractedInvoiceNumber ?? undefined,
      partnerId: file.partnerId ?? undefined,
      documentType: file.documentType ?? undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    file?.extractedAmount,
    file?.extractedTipAmount,
    file?.extractedCurrency,
    extractedDateMs,
    dueDateMs,
    debitDateMs,
    file?.extractedPartner,
    file?.extractedIban,
    file?.extractedText,
    file?.extractedInvoiceNumber,
    file?.partnerId,
    file?.documentType,
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
    ineligible,
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

  // Transactions the scorer returned this time, whose Coverage it reported.
  const scoredIds = useMemo(
    () => new Set(serverMatches.map((m) => m.transactionId)),
    [serverMatches]
  );

  // Filter and sort transactions: when searching, only show matches
  const filteredTransactions = useMemo(() => {
    const trimmedSearch = search.trim();

    // When searching, filter to only matching transactions
    const filtered = trimmedSearch
      ? transactions.filter((tx) => {
          // Include if server scored it
          if (matchMap.has(tx.id)) return true;
          // Include on the server's own predicate (#183): text over
          // name/partner/reference OR the amount. One function on both sides,
          // so the list does not change as the debounce resolves.
          return matchesTransactionSearch(tx, trimmedSearch);
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

  // Sort and chips (#244). Remembered while the app is open, reset on reload.
  const [controls, setControlsState] = useState<ConnectControls>(rememberedConnectControls);
  const updateControls = useCallback((patch: Partial<ConnectControls>) => {
    setControlsState((prev) => {
      const next = { ...prev, ...patch };
      rememberConnectControls(next);
      return next;
    });
  }, []);
  const fileDateMs = extractedDateValue?.getTime() ?? null;
  const filePartnerId = file?.partnerId ?? null;

  // Applied on top of the search result above, client-side over the
  // candidates already loaded; the query the overlay issues is unchanged.
  const visibleTransactions = useMemo(() => {
    const candidates = filteredTransactions.map((tx) => ({
      id: tx.id,
      dateMs: tx.date.toMillis(),
      partnerId: tx.partnerId ?? null,
      tx,
    }));
    const narrowed = filterConnectCandidates(candidates, {
      partnerId: controls.partnerOnly ? filePartnerId : null,
      dateWindowDays: controls.dateWindowDays,
      referenceDateMs: fileDateMs,
    });
    return sortConnectCandidates(narrowed, controls.sort, {
      // Best match is the server's match confidence, never a local score.
      confidenceOf: (c) => matchMap.get(c.id)?.confidence,
      referenceDateMs: fileDateMs,
    }).map((c) => c.tx);
  }, [filteredTransactions, controls, filePartnerId, fileDateMs, matchMap]);

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

  /**
   * The Remainder this row prints (#243): the scorer's own Coverage when it
   * returned one for the pair, otherwise the same derivation over the Files on
   * the Transaction. Null for a Transaction that is documented or holds none.
   */
  const remainderFor = (
    transaction: Transaction,
    matchResult: TransactionMatchResult | undefined
  ): string | undefined => {
    let coverage = matchResult?.coverage ?? null;
    // A stored suggestion standing in for the server carries no Coverage.
    if (!matchResult || !scoredIds.has(transaction.id)) {
      const connected = (transaction.fileIds ?? [])
        .filter((id) => id !== file?.id)
        .map((id) => filesById.get(id))
        .filter((f): f is TaxFile => f !== undefined);
      coverage = coverageFromConnectedFiles(transaction.amount, connected);
    }
    const remainder = rowRemainder(coverage);
    return remainder == null ? undefined : formatAmount(remainder, transaction.currency);
  };

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
          <div className="w-[35%] min-w-[280px] max-w-[420px] shrink-0 border-r flex flex-col min-h-0 overflow-hidden">
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

              {/* Sort and chips (#244): above the scroll area, never behind a disclosure */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">Sort</span>
                <Select
                  value={controls.sort}
                  onValueChange={(value) => updateControls({ sort: value as ConnectSortMode })}
                >
                  <SelectTrigger className="h-8 text-xs" aria-label="Sort transactions">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONNECT_SORT_OPTIONS.map((option) => (
                      <SelectItem
                        key={option.value}
                        value={option.value}
                        disabled={option.value === "closest-date" && fileDateMs == null}
                        className="text-xs"
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {filePartnerId && (
                  <Button
                    type="button"
                    size="sm"
                    variant={controls.partnerOnly ? "default" : "outline"}
                    className="h-6 px-2 text-xs rounded-full"
                    aria-pressed={controls.partnerOnly}
                    onClick={() => updateControls({ partnerOnly: !controls.partnerOnly })}
                  >
                    This Partner only
                  </Button>
                )}
                {CONNECT_DATE_WINDOW_OPTIONS.map((option) => {
                  const active = controls.dateWindowDays === option.value;
                  return (
                    <Button
                      key={option.label}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      className="h-6 px-2 text-xs rounded-full"
                      aria-pressed={active}
                      // A window around the File's date needs a File date.
                      disabled={option.value != null && fileDateMs == null}
                      onClick={() => updateControls({ dateWindowDays: option.value })}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
            </div>

            {ineligible ? (
              <p className="px-4 py-2 text-xs text-muted-foreground border-b">{t(ineligibleKey(ineligible))}</p>
            ) : null}

            {/* Transaction list */}
            <ScrollArea className="flex-1">
              {loading ? (
                <div className="p-8 text-sm text-muted-foreground text-center">
                  <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin" />
                  {matchesLoading ? "Finding best matches..." : "Loading transactions..."}
                </div>
              ) : visibleTransactions.length === 0 ? (
                <div className="p-8 text-sm text-muted-foreground text-center">
                  <Receipt className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p>
                    {search
                      ? "No transactions match your search"
                      : controls.partnerOnly || controls.dateWindowDays != null
                      ? "No transactions match these filters"
                      : "No transactions found"}
                  </p>
                </div>
              ) : (
                <div className="p-2 space-y-1 overflow-hidden">
                  {visibleTransactions.map((transaction) => {
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
                        // Files already on this Transaction, and what is still
                        // open on it (#243). Never hidden or disabled for it:
                        // a split part-invoice belongs exactly here.
                        connectionCount={otherConnectionCount(transaction.fileIds, file?.id)}
                        connectionNoun="File"
                        remainder={remainderFor(transaction, matchResult)}
                        isHighlighted={isSuggested}
                        highlightVariant="suggestion"
                        confidence={matchResult?.confidence}
                        // A search shows held-back pairs too, marked (#613).
                        labelBadge={matchResult?.hidden ? t(heldBackKey(matchResult.hidden)) : undefined}
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
