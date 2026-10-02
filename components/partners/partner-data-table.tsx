"use client";

import * as React from "react";
import { ColumnDef } from "@tanstack/react-table";
import { forwardRef, ReactNode } from "react";
import { UserPartner } from "@/types/partner";
import {
  ResizableDataTable,
  DataTableHandle,
  SelectionChangeMeta,
} from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { SELECT_COLUMN_WIDTH } from "@/components/files/files-data-table";
import { getPartnerColumns } from "./partner-columns";

type IdSet = Set<string>;

interface PartnerDataTableProps {
  data: UserPartner[];
  /** The Partner open in the detail panel (a plain click). */
  selectedRowId?: string | null;
  /** Partner IDs marked as "my company" */
  markedAsMe?: string[];
  /** Custom empty state component */
  emptyState?: ReactNode;
  /**
   * Everything selected, browsed row included: the table highlights these and
   * reads cmd/shift-click against them, as the Files table does (#524).
   */
  selectedRowIds?: IdSet;
  /** What the checkbox column shows ticked: the bulk selection only. */
  checkedRowIds?: IdSet;
  onSelectionChange?: (selectedIds: IdSet, meta: SelectionChangeMeta) => void;
  onToggleRow?: (partnerId: string, checked: boolean) => void;
  onToggleSelectAll?: () => void;
  selectAllState?: boolean | "indeterminate";
}

export interface PartnerDataTableHandle {
  scrollToIndex: (index: number) => void;
}

// Default column sizes for partners table
const DEFAULT_PARTNER_COLUMN_SIZES: Record<string, number> = {
  select: SELECT_COLUMN_WIDTH,
  name: 200,
  vatId: 120,
  ibans: 180,
  website: 150,
};

function PartnerDataTableInner(
  {
    data,
    selectedRowId,
    markedAsMe,
    emptyState,
    selectedRowIds,
    checkedRowIds,
    onSelectionChange,
    onToggleRow,
    onToggleSelectAll,
    selectAllState = false,
  }: PartnerDataTableProps,
  ref: React.ForwardedRef<PartnerDataTableHandle>
) {
  const dataColumns = React.useMemo(() => getPartnerColumns({ markedAsMe }), [markedAsMe]);

  const selectionColumn: ColumnDef<UserPartner> = React.useMemo(
    () => ({
      id: "select",
      size: SELECT_COLUMN_WIDTH,
      minSize: SELECT_COLUMN_WIDTH,
      maxSize: SELECT_COLUMN_WIDTH,
      enableResizing: false,
      header: () => (
        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selectAllState}
            onCheckedChange={() => onToggleSelectAll?.()}
            aria-label="Select all partners"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={(checkedRowIds ?? selectedRowIds)?.has(row.original.id) ?? false}
            onCheckedChange={(checked) => onToggleRow?.(row.original.id, checked === true)}
            aria-label={`Select ${row.original.name}`}
          />
        </div>
      ),
    }),
    [selectAllState, checkedRowIds, selectedRowIds, onToggleRow, onToggleSelectAll]
  );

  const columns = React.useMemo(
    () => [selectionColumn, ...dataColumns],
    [selectionColumn, dataColumns]
  );

  // Get data attributes for row
  const getRowDataAttributes = React.useCallback((row: UserPartner) => {
    return { "partner-id": row.id };
  }, []);

  return (
    <ResizableDataTable
      ref={ref as React.Ref<DataTableHandle>}
      columns={columns}
      data={data}
      selectedRowId={selectedRowId}
      defaultColumnSizes={DEFAULT_PARTNER_COLUMN_SIZES}
      getRowDataAttributes={getRowDataAttributes}
      emptyState={emptyState}
      emptyMessage="No partners found."
      enableMultiSelect
      selectedRowIds={selectedRowIds}
      onSelectionChange={onSelectionChange}
    />
  );
}

export const PartnerDataTable = forwardRef(PartnerDataTableInner);
