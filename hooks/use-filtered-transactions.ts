"use client";

import { toDateSafe } from "@/lib/utils";
import { useMemo, useDeferredValue } from "react";
import { Transaction, TransactionFilters } from "@/types/transaction";

/**
 * Client-side filtering hook for transactions.
 * Applies all filter criteria and returns filtered list.
 */
export function useFilteredTransactions(
  transactions: Transaction[],
  filters: TransactionFilters,
  searchValue: string
): Transaction[] {
  const filtered = useMemo(() => {
    let result = transactions;

    // Text search
    if (searchValue.trim()) {
      const search = searchValue.toLowerCase();
      result = result.filter(
        (t) =>
          t.name?.toLowerCase().includes(search) ||
          t.description?.toLowerCase().includes(search) ||
          t.partner?.toLowerCase().includes(search)
      );
    }

    // Import ID filter
    if (filters.importId) {
      result = result.filter((t) => t.importJobId === filters.importId);
    }

    // Source filter
    if (filters.sourceId) {
      result = result.filter((t) => t.sourceId === filters.sourceId);
    }

    const partnerIds = filters.partnerIds && filters.partnerIds.length > 0
      ? filters.partnerIds
      : filters.partnerId
        ? [filters.partnerId]
        : [];

    if (partnerIds.length > 0) {
      const allowedPartners = new Set(partnerIds);
      result = result.filter((t) => t.partnerId && allowedPartners.has(t.partnerId));
    }

    // Date range filter
    // Handle case where dateFrom > dateTo (e.g., "Oct 27 - Jan 27" when both default to same year)
    let effectiveDateFrom = filters.dateFrom;
    let effectiveDateTo = filters.dateTo;
    if (effectiveDateFrom && effectiveDateTo && effectiveDateFrom.getTime() > effectiveDateTo.getTime()) {
      // Swap them - user likely meant the earlier date as "from"
      [effectiveDateFrom, effectiveDateTo] = [effectiveDateTo, effectiveDateFrom];
    }

    if (effectiveDateFrom) {
      const fromTime = effectiveDateFrom.getTime();
      result = result.filter((t) => {
        const txDate = toDateSafe(t.date);
        return txDate ? txDate.getTime() >= fromTime : true;
      });
    }
    if (effectiveDateTo) {
      // Add one day to include the end date fully
      const toTime = effectiveDateTo.getTime() + 24 * 60 * 60 * 1000;
      result = result.filter((t) => {
        const txDate = toDateSafe(t.date);
        return txDate ? txDate.getTime() < toTime : true;
      });
    }

    // Amount type filter
    if (filters.amountType === "income") {
      result = result.filter((t) => t.amount > 0);
    } else if (filters.amountType === "expense") {
      result = result.filter((t) => t.amount < 0);
    }

    // Completion status filter
    if (filters.isComplete !== undefined) {
      result = result.filter((t) => t.isComplete === filters.isComplete);
    }

    return result;
  }, [transactions, filters, searchValue]);

  // Defer the filtered result to prevent blocking the UI during heavy filtering
  return useDeferredValue(filtered);
}
