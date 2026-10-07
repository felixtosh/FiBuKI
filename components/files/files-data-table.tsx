"use client";

import * as React from "react";
import { forwardRef, ReactNode } from "react";
import { ColumnDef, SortingState } from "@tanstack/react-table";
import { TaxFile } from "@/types/file";
import {
  ResizableDataTable,
  DataTableHandle,
  SelectionChangeMeta,
} from "@/components/ui/data-table";

interface FilesDataTableProps {
  columns: ColumnDef<TaxFile, unknown>[];
  data: TaxFile[];
  onRowClick?: (row: TaxFile) => void;
  selectedRowId?: string | null;
  // Multi-select props
  enableMultiSelect?: boolean;
  selectedRowIds?: Set<string>;
  onSelectionChange?: (selectedIds: Set<string>, meta: SelectionChangeMeta) => void;
  /** Callback with the row ids in displayed order (filtered rows, active sort) */
  onDisplayedOrderChange?: (orderedIds: string[]) => void;
  /** Custom empty state component */
  emptyState?: ReactNode;
  /** Set of file IDs that are currently being searched - used to bust row memo cache */
  searchingFileIds?: Set<string>;
  /** Override the initial sort (the deleted-files view reads newest-deleted-first, #268) */
  initialSorting?: SortingState;
}

export interface FilesDataTableHandle {
  scrollToIndex: (index: number) => void;
}

/**
 * The checkbox column is fixed: 16px left padding, a 16px box, and 16px to the
 * column line (8px of slack plus the cell's 8px right padding). Any narrower
 * and the header's overflow clip cuts the select-all box off.
 */
export const SELECT_COLUMN_WIDTH = 48;

// Default column sizes for files table
const DEFAULT_FILE_COLUMN_SIZES: Record<string, number> = {
  select: SELECT_COLUMN_WIDTH,
  extractedDate: 156,
  extractedAmount: 120,
  extractedVatPercent: 55,
  fileName: 190,
  sourceType: 180,
  uploadedAt: 125,
  assignedPartner: 140,
  connections: 100,
};

// Default sorting - matches Firestore query orderBy("uploadedAt", "desc")
const DEFAULT_SORTING: SortingState = [{ id: "uploadedAt", desc: true }];

function FilesDataTableInner(
  {
    columns,
    data,
    onRowClick,
    selectedRowId,
    enableMultiSelect,
    selectedRowIds,
    onSelectionChange,
    onDisplayedOrderChange,
    emptyState,
    searchingFileIds,
    initialSorting,
  }: FilesDataTableProps,
  ref: React.ForwardedRef<FilesDataTableHandle>
) {
  const isFileConnected = React.useCallback((row: TaxFile) => row.transactionIds.length > 0, []);

  // Get row className based on status
  const getRowClassName = React.useCallback(
    (row: TaxFile, isSelected: boolean) => {
      // Deleted files - strikethrough and faded (keep even when selected)
      if (row.deletedAt) {
        return "opacity-50 line-through";
      }

      // Not invoice files - greyed out but preserve selection state
      if (row.isNotInvoice && !isSelected) {
        return "opacity-60 bg-muted/50";
      }
      if (row.isNotInvoice && isSelected) {
        return "opacity-75"; // Slightly faded but keep selected bg
      }

      // Connected files - green highlight
      const hasConnections = row.transactionIds.length > 0;
      if (hasConnections) {
        if (isSelected) {
          // Active/selected connected files: darker green
          return "bg-complete-row-selected hover:bg-complete-row-selected/80";
        }
        // Non-selected connected files: light green
        return "bg-complete-row hover:bg-complete-row/80";
      }

      return "";
    },
    []
  );

  // Get data attributes for row
  const getRowDataAttributes = React.useCallback((row: TaxFile) => {
    return { "file-id": row.id };
  }, []);

  // Get row state key - used to bust memo cache when searching state changes
  const getRowStateKey = React.useCallback(
    (row: TaxFile) => {
      return searchingFileIds?.has(row.id) ?? false;
    },
    [searchingFileIds]
  );

  return (
    <ResizableDataTable
      ref={ref as React.Ref<DataTableHandle>}
      columnWidthsStorageKey="fibuki.columnWidths.files"
      columns={columns}
      data={data}
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      defaultColumnSizes={DEFAULT_FILE_COLUMN_SIZES}
      initialSorting={initialSorting ?? DEFAULT_SORTING}
      // Connected files are the green ones (getRowClassName above).
      isRowComplete={isFileConnected}
      getRowClassName={getRowClassName}
      getRowDataAttributes={getRowDataAttributes}
      getRowStateKey={getRowStateKey}
      emptyState={emptyState}
      emptyMessage="No files found."
      enableMultiSelect={enableMultiSelect}
      selectedRowIds={selectedRowIds}
      onSelectionChange={onSelectionChange}
      onDisplayedOrderChange={onDisplayedOrderChange}
    />
  );
}

export const FilesDataTable = forwardRef(FilesDataTableInner);
