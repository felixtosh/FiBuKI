"use client";

import * as React from "react";
import { ColumnDef } from "@tanstack/react-table";
import { forwardRef, ReactNode } from "react";
import { UserPartner } from "@/types/partner";
import {
  ResizableDataTable,
  DataTableHandle,
} from "@/components/ui/data-table";
import { Checkbox } from "@/components/ui/checkbox";
import { getPartnerColumns } from "./partner-columns";

interface PartnerDataTableProps {
  data: UserPartner[];
  onRowClick?: (partner: UserPartner) => void;
  selectedRowId?: string | null;
  onEdit?: (partner: UserPartner) => void;
  onDelete?: (partnerId: string) => void;
  /** Partner IDs marked as "my company" */
  markedAsMe?: string[];
  /** Custom empty state component */
  emptyState?: ReactNode;
  /** Shows a checkbox column for bulk selection (e.g. to merge duplicates) */
  enableSelection?: boolean;
  selectedRowIds?: Set<string>;
  onToggleRow?: (partnerId: string, checked: boolean) => void;
  onToggleSelectAll?: () => void;
  selectAllState?: boolean | "indeterminate";
}

export interface PartnerDataTableHandle {
  scrollToIndex: (index: number) => void;
}

// Default column sizes for partners table
const DEFAULT_PARTNER_COLUMN_SIZES: Record<string, number> = {
  select: 36,
  name: 200,
  vatId: 120,
  ibans: 180,
  website: 150,
  actions: 50,
};

function PartnerDataTableInner(
  {
    data,
    onRowClick,
    selectedRowId,
    onEdit,
    onDelete,
    markedAsMe,
    emptyState,
    enableSelection,
    selectedRowIds,
    onToggleRow,
    onToggleSelectAll,
    selectAllState = false,
  }: PartnerDataTableProps,
  ref: React.ForwardedRef<PartnerDataTableHandle>
) {
  const dataColumns = React.useMemo(
    () => getPartnerColumns({ onEdit, onDelete, markedAsMe }),
    [onEdit, onDelete, markedAsMe]
  );

  const selectionColumn: ColumnDef<UserPartner> = React.useMemo(
    () => ({
      id: "select",
      size: 36,
      minSize: 36,
      maxSize: 36,
      enableResizing: false,
      header: () => (
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selectAllState}
            onCheckedChange={() => onToggleSelectAll?.()}
            aria-label="Select all partners"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selectedRowIds?.has(row.original.id) ?? false}
            onCheckedChange={(checked) => onToggleRow?.(row.original.id, checked === true)}
            aria-label={`Select ${row.original.name}`}
          />
        </div>
      ),
    }),
    [selectAllState, selectedRowIds, onToggleRow, onToggleSelectAll]
  );

  const columns = React.useMemo(
    () => (enableSelection ? [selectionColumn, ...dataColumns] : dataColumns),
    [enableSelection, selectionColumn, dataColumns]
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
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      defaultColumnSizes={DEFAULT_PARTNER_COLUMN_SIZES}
      getRowDataAttributes={getRowDataAttributes}
      emptyState={emptyState}
      emptyMessage="No partners found."
    />
  );
}

export const PartnerDataTable = forwardRef(PartnerDataTableInner);
