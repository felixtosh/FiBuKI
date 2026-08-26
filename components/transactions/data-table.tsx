"use client";

import * as React from "react";
import { forwardRef, ReactNode } from "react";
import { ColumnDef, SortingState } from "@tanstack/react-table";
import { Transaction } from "@/types/transaction";
import {
  ResizableDataTable,
  DataTableHandle,
} from "@/components/ui/data-table";
import { MOTION, isRecentlyUpdated } from "@/design-system";

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  onRowClick?: (row: TData) => void;
  selectedRowId?: string | null;
  /** Custom empty state component */
  emptyState?: ReactNode;
  /** Callback with the row ids in displayed order (filtered rows, active sort) */
  onDisplayedOrderChange?: (orderedIds: string[]) => void;
  /** Set of transaction IDs that are currently being searched - used to bust row memo cache */
  searchingTransactionIds?: Set<string>;
}

export type { DataTableHandle };

// Default column sizes for transaction table
const DEFAULT_TRANSACTION_COLUMN_SIZES: Record<string, number> = {
  date: 110,
  amount: 100,
  name: 220,
  assignedPartner: 240,
  file: 140,
  documentation: 130,
  sourceId: 120,
};

// Default sorting - matches Firestore query orderBy("date", "desc")
const DEFAULT_SORTING: SortingState = [{ id: "date", desc: true }];

function DataTableInner<TData extends { id: string }>(
  {
    columns,
    data,
    onRowClick,
    selectedRowId,
    emptyState,
    onDisplayedOrderChange,
    searchingTransactionIds,
  }: DataTableProps<TData>,
  ref: React.ForwardedRef<DataTableHandle>
) {
  // Type guard to check if row is a transaction
  const isTransactionRow = (row: TData): row is TData & Transaction => {
    return "description" in row || "fileIds" in row;
  };

  // Compute completion status from fileIds and noReceiptCategoryId (no stored field needed)
  const isRowComplete = (row: TData & Transaction): boolean => {
    return (row.fileIds && row.fileIds.length > 0) || !!row.noReceiptCategoryId;
  };

  // Get row className based on completion status
  const getRowClassName = React.useCallback(
    (row: TData, isSelected: boolean) => {
      if (isTransactionRow(row)) {
        // Quota-exceeded rows: greyed out
        if ((row as unknown as Record<string, unknown>).quotaExceeded) {
          return "opacity-50";
        }

        if (isRowComplete(row)) {
          // Check if this row just became complete (glow animation)
          const justCompleted = isRecentlyUpdated(
            (row as unknown as Record<string, unknown>).updatedAt,
            MOTION.JUST_COMPLETED_THRESHOLD_MS
          );
          const glowClass = justCompleted ? "animate-row-complete" : "";

          if (isSelected) {
            return `bg-complete-row-selected hover:bg-complete-row-selected/80 ${glowClass}`;
          }
          return `bg-complete-row hover:bg-complete-row/80 ${glowClass}`;
        }
      }
      return "";
    },
    []
  );

  // Get data attributes for row
  const getRowDataAttributes = React.useCallback((row: TData) => {
    return { "transaction-id": row.id };
  }, []);

  // Get row state key - used to bust memo cache when searching state changes
  const getRowStateKey = React.useCallback(
    (row: TData) => {
      // Return whether this row is being searched - changes to this trigger re-render
      return searchingTransactionIds?.has(row.id) ?? false;
    },
    [searchingTransactionIds]
  );

  return (
    <ResizableDataTable
      ref={ref}
      columns={columns}
      data={data}
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      defaultColumnSizes={DEFAULT_TRANSACTION_COLUMN_SIZES}
      initialSorting={DEFAULT_SORTING}
      getRowClassName={getRowClassName}
      getRowDataAttributes={getRowDataAttributes}
      getRowStateKey={getRowStateKey}
      emptyState={emptyState}
      emptyMessage="No transactions found."
      onDisplayedOrderChange={onDisplayedOrderChange}
    />
  );
}

// Export with forwardRef - using type assertion for generic component with ref
export const DataTable = forwardRef(DataTableInner) as <
  TData extends { id: string }
>(
  props: DataTableProps<TData> & { ref?: React.Ref<DataTableHandle> }
) => React.ReactElement;
