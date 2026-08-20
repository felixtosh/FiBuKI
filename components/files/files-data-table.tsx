"use client";

import * as React from "react";
import { forwardRef, ReactNode } from "react";
import { ColumnDef, SortingState } from "@tanstack/react-table";
import { TaxFile } from "@/types/file";
import {
  ResizableDataTable,
  DataTableHandle,
} from "@/components/ui/data-table";

interface FilesDataTableProps {
  columns: ColumnDef<TaxFile, unknown>[];
  data: TaxFile[];
  onRowClick?: (row: TaxFile) => void;
  selectedRowId?: string | null;
  // Multi-select props
  enableMultiSelect?: boolean;
  selectedRowIds?: Set<string>;
  onSelectionChange?: (selectedIds: Set<string>) => void;
  /** Custom empty state component */
  emptyState?: ReactNode;
  /** Set of file IDs that are currently being searched - used to bust row memo cache */
  searchingFileIds?: Set<string>;
}

export interface FilesDataTableHandle {
  scrollToIndex: (index: number) => void;
}

// Default column sizes for files table
const DEFAULT_FILE_COLUMN_SIZES: Record<string, number> = {
  select: 36,
  extractedDate: 110,
  extractedAmount: 90,
  extractedVatPercent: 55,
  fileName: 190,
  sourceType: 80,
  uploadedAt: 115,
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
    emptyState,
    searchingFileIds,
  }: FilesDataTableProps,
  ref: React.ForwardedRef<FilesDataTableHandle>
) {
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
      columns={columns}
      data={data}
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      defaultColumnSizes={DEFAULT_FILE_COLUMN_SIZES}
      initialSorting={DEFAULT_SORTING}
      getRowClassName={getRowClassName}
      getRowDataAttributes={getRowDataAttributes}
      getRowStateKey={getRowStateKey}
      emptyState={emptyState}
      emptyMessage="No files found."
      enableMultiSelect={enableMultiSelect}
      selectedRowIds={selectedRowIds}
      onSelectionChange={onSelectionChange}
    />
  );
}

export const FilesDataTable = forwardRef(FilesDataTableInner);
