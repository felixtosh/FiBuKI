"use client";

import { useMemo, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Receipt, Search, Building2 } from "lucide-react";
import { useTransactions } from "@/hooks/use-transactions";
import { useSources } from "@/hooks/use-sources";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
import { useFiles } from "@/hooks/use-files";
import { useFilteredTransactions } from "@/hooks/use-filtered-transactions";
import { parseFiltersFromUrl, buildFilterUrl } from "@/lib/filters/url-params";
// Category suggestions come from transaction.categorySuggestions (computed on backend)
import { DataTable, DataTableHandle } from "./data-table";
import { getTransactionColumns } from "./transaction-columns";
import { TransactionToolbar } from "./transaction-toolbar";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import { Transaction, TransactionFilters } from "@/types/transaction";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { CategorySuggestion } from "@/types/no-receipt-category";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePrecisionSearchContext } from "@/hooks/use-precision-search-context";

interface TransactionTableProps {
  onSelectTransaction: (transaction: Transaction) => void;
  selectedTransactionId: string | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  userPartners?: UserPartner[];
  globalPartners?: GlobalPartner[];
  tableRef?: React.RefObject<DataTableHandle | null>;
}

export function TransactionTable({
  onSelectTransaction,
  selectedTransactionId,
  searchValue,
  onSearchChange,
  userPartners = [],
  globalPartners = [],
  tableRef: externalTableRef,
}: TransactionTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { transactions, loading, error } = useTransactions();
  const { sources } = useSources();
  const { categories } = useNoReceiptCategories();
  const { files } = useFiles();
  const { searchingTransactions } = usePrecisionSearchContext();

  // Internal ref for DataTable, use external if provided
  const internalTableRef = useRef<DataTableHandle>(null);
  const tableRef = externalTableRef || internalTableRef;

  // Find and open a transaction by ID (for chat UI control)
  const openTransactionById = useCallback(
    (transactionId: string) => {
      const transaction = transactions.find((t) => t.id === transactionId);
      if (transaction) {
        onSelectTransaction(transaction);
      }
    },
    [transactions, onSelectTransaction]
  );

  // Parse filters from URL
  const filters = useMemo(
    () => parseFiltersFromUrl(searchParams),
    [searchParams]
  );

  // Apply filters using the hook
  const filteredTransactions = useFilteredTransactions(
    transactions,
    filters,
    searchValue
  );

  // Calculate assigned count and sum of amounts
  const { assignedCount, totalCount, filteredSum, scorePercent } = useMemo(() => {
    const total = filteredTransactions.length;
    const assigned = filteredTransactions.filter(
      (tx) => (tx.fileIds && tx.fileIds.length > 0) || tx.noReceiptCategoryId
    ).length;
    const sum = filteredTransactions.reduce((acc, tx) => acc + (tx.amount || 0), 0);
    const score = total > 0 ? Math.round((assigned / total) * 100) : 0;
    return { assignedCount: assigned, totalCount: total, filteredSum: sum, scorePercent: score };
  }, [filteredTransactions]);

  // Scroll to and highlight a transaction by ID (uses virtualizer for off-screen items)
  const scrollToTransactionById = useCallback((transactionId: string) => {
    // Find the index in filtered transactions (what's displayed in the table)
    const index = filteredTransactions.findIndex((t) => t.id === transactionId);
    if (index !== -1) {
      // Use virtualizer to scroll first (ensures row is rendered)
      tableRef.current?.scrollToIndex(index);

      // Then highlight after a short delay for the row to render
      setTimeout(() => {
        const element = document.querySelector(
          `[data-transaction-id="${transactionId}"]`
        );
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          element.classList.add("animate-pulse", "bg-primary/10");
          setTimeout(() => {
            element.classList.remove("animate-pulse", "bg-primary/10");
          }, 2000);
        }
      }, 50);
    }
  }, [filteredTransactions, tableRef]);

  // Listen for chat UI control events
  useEffect(() => {
    const handleOpenTransaction = (
      e: CustomEvent<{ transactionId: string }>
    ) => {
      openTransactionById(e.detail.transactionId);
    };

    const handleScrollToTransaction = (
      e: CustomEvent<{ transactionId: string }>
    ) => {
      scrollToTransactionById(e.detail.transactionId);
    };

    const handleHighlightTransaction = (
      e: CustomEvent<{ transactionId: string }>
    ) => {
      scrollToTransactionById(e.detail.transactionId);
    };

    window.addEventListener(
      "chat:openTransaction",
      handleOpenTransaction as EventListener
    );
    window.addEventListener(
      "chat:scrollToTransaction",
      handleScrollToTransaction as EventListener
    );
    window.addEventListener(
      "chat:highlightTransaction",
      handleHighlightTransaction as EventListener
    );

    return () => {
      window.removeEventListener(
        "chat:openTransaction",
        handleOpenTransaction as EventListener
      );
      window.removeEventListener(
        "chat:scrollToTransaction",
        handleScrollToTransaction as EventListener
      );
      window.removeEventListener(
        "chat:highlightTransaction",
        handleHighlightTransaction as EventListener
      );
    };
  }, [openTransactionById, scrollToTransactionById]);

  // Update URL when filters change
  const handleFiltersChange = (newFilters: TransactionFilters) => {
    const url = buildFilterUrl("/transactions", newFilters);
    router.push(url);
  };

  // Use stored category suggestions from backend (no client-side computation)
  const categorySuggestions = useMemo(() => {
    const map = new Map<string, CategorySuggestion>();

    for (const tx of transactions) {
      // Skip if already has category or files
      if (tx.noReceiptCategoryId || (tx.fileIds && tx.fileIds.length > 0)) {
        continue;
      }
      // Use stored suggestions from transaction (computed by backend)
      if (tx.categorySuggestions && tx.categorySuggestions.length > 0) {
        map.set(tx.id, tx.categorySuggestions[0]); // Take top suggestion
      }
    }
    return map;
  }, [transactions]);

  // Create a map of transactionId -> file amounts data for AmountMatchDisplay
  const fileAmountsMap = useMemo(() => {
    const map = new Map<string, {
      totalAmount: number;
      fileCount: number;
      amounts: Array<{ amount: number; currency: string }>;
      hasExtractingFiles: boolean;
    }>();
    for (const file of files) {
      if (file.transactionIds.length > 0) {
        for (const txId of file.transactionIds) {
          const existing = map.get(txId);
          const isExtracting = !file.extractionComplete && !file.isNotInvoice;

          if (file.extractedAmount != null) {
            const fileEntry = {
              amount: file.extractedAmount,
              currency: file.extractedCurrency || "EUR",
            };
            if (existing) {
              existing.totalAmount += file.extractedAmount;
              existing.amounts.push(fileEntry);
              existing.hasExtractingFiles = existing.hasExtractingFiles || isExtracting;
            } else {
              map.set(txId, {
                totalAmount: file.extractedAmount,
                fileCount: 1,
                amounts: [fileEntry],
                hasExtractingFiles: isExtracting,
              });
            }
          } else if (isExtracting) {
            // File connected but not yet extracted
            if (existing) {
              existing.hasExtractingFiles = true;
            } else {
              map.set(txId, {
                totalAmount: 0,
                fileCount: 0,
                amounts: [],
                hasExtractingFiles: true,
              });
            }
          }
        }
      }
    }
    return map;
  }, [files]);

  // Create columns with sources and partners lookup - must be before conditional returns
  const columns = useMemo(
    () => getTransactionColumns(
      sources,
      userPartners,
      globalPartners,
      categories,
      categorySuggestions,
      fileAmountsMap,
      searchingTransactions
    ),
    [sources, userPartners, globalPartners, categories, categorySuggestions, fileAmountsMap, searchingTransactions]
  );

  const handleRowClick = (transaction: Transaction) => {
    onSelectTransaction(transaction);
  };

  // Determine which empty state to show
  const hasAnyFilters = searchValue || filters.dateFrom || filters.dateTo ||
    filters.isComplete !== undefined || filters.amountType || filters.partnerIds?.length;

  const emptyState = useMemo(() => {
    // Don't show empty state while still loading - prevents flicker
    if (loading) {
      return null;
    }
    if (transactions.length === 0) {
      // No transactions at all - show "add account" CTA
      return (
        <TableEmptyState
          icon={<Receipt className="h-full w-full" />}
          title={emptyStatePresets.transactions.noData.title}
          description={emptyStatePresets.transactions.noData.description}
          action={{
            label: emptyStatePresets.transactions.noData.actionLabel!,
            onClick: () => router.push("/sources"),
            icon: <Building2 className="h-4 w-4" />,
          }}
        />
      );
    }
    // Has transactions but filters returned nothing
    return (
      <TableEmptyState
        icon={<Search className="h-full w-full" />}
        title={emptyStatePresets.transactions.noResults.title}
        description={emptyStatePresets.transactions.noResults.description}
        action={hasAnyFilters ? {
          label: emptyStatePresets.transactions.noResults.actionLabel!,
          onClick: () => router.push("/transactions"),
        } : undefined}
        size="sm"
      />
    );
  }, [loading, transactions.length, hasAnyFilters, router]);

  if (error) {
    return (
      <div className="text-center py-10">
        <p className="text-destructive mb-2">Error loading transactions</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Fixed toolbar */}
      <TransactionToolbar
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        userPartners={userPartners}
        assignedCount={assignedCount}
        totalCount={totalCount}
        filteredSum={filteredSum}
        scorePercent={scorePercent}
      />

      {/* Scrollable table area */}
      <div className="flex-1 flex flex-col min-h-0">
        <TooltipProvider>
          <DataTable
            ref={tableRef}
            columns={columns}
            data={filteredTransactions}
            onRowClick={handleRowClick}
            selectedRowId={selectedTransactionId}
            emptyState={emptyState}
            searchingTransactionIds={searchingTransactions}
          />
        </TooltipProvider>
      </div>

    </div>
  );
}
