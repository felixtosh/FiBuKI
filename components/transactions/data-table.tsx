"use client";

import * as React from "react";
import { forwardRef, ReactNode } from "react";
import { ColumnDef, SortingState } from "@tanstack/react-table";
import { Transaction } from "@/types/transaction";
import {
  ResizableDataTable,
  DataTableHandle,
} from "@/components/ui/data-table";
import { createListMotion, type ListMotion } from "@/lib/motion/list-motion";
import { LIST_MOTION } from "@/lib/motion/settings";

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
  /**
   * Rows arrive, turn green (or back) and glide as LIST_MOTION says (on by
   * default). The motion lab turns it off and runs the same engine with its
   * own settings.
   */
  animateRows?: boolean;
}

export type { DataTableHandle };

// Default column sizes for transaction table
const DEFAULT_TRANSACTION_COLUMN_SIZES: Record<string, number> = {
  date: 110,
  amount: 100,
  name: 220,
  assignedPartner: 240,
  file: 140,
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
    animateRows = true,
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

        // Turning green is animated by the list motion below, only when it
        // happens on screen; the colour itself is just the state.
        if (isRowComplete(row)) {
          if (isSelected) {
            return "bg-complete-row-selected hover:bg-complete-row-selected/80";
          }
          return "bg-complete-row hover:bg-complete-row/80";
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

  // Rows arriving, turning green (or back) and gliding (lib/motion). Runs after
  // the table has rendered and before the browser paints.
  const motionRoot = React.useRef<HTMLDivElement>(null);
  const motion = React.useRef(null as ListMotion | null);
  React.useLayoutEffect(() => {
    if (!animateRows) return;
    motion.current ??= createListMotion();
    motion.current.update(
      motionRoot.current,
      data.map((row) => ({
        id: row.id,
        complete: isTransactionRow(row) && isRowComplete(row),
      })),
      LIST_MOTION
    );
    // isTransactionRow / isRowComplete are pure helpers re-created each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, animateRows]);

  // display: contents adds no box, so the table lays out exactly as before.
  return (
    <div ref={motionRoot} className="contents">
      <ResizableDataTable
        ref={ref}
        columnWidthsStorageKey="fibuki.columnWidths.transactions"
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
    </div>
  );
}

// Export with forwardRef - using type assertion for generic component with ref
export const DataTable = forwardRef(DataTableInner) as <
  TData extends { id: string },
>(
  props: DataTableProps<TData> & { ref?: React.Ref<DataTableHandle> },
) => React.ReactElement;
