"use client";

import { useMemo, forwardRef } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { Loader2, Mail, FileText, Search, Upload } from "lucide-react";
import { FilesDataTable, FilesDataTableHandle, SELECT_COLUMN_WIDTH } from "./files-data-table";
import { FileToolbar } from "./file-toolbar";
import { getFileColumns } from "./file-columns";
import { useEcbConverter } from "@/lib/currency";
import { Checkbox } from "@/components/ui/checkbox";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import { TaxFile, FileFilters } from "@/types/file";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { useRunningWorkers } from "@/hooks/use-running-workers";
import { SelectAllCheckedState } from "@/lib/selection/bulk-file-selection";
import { SelectionChangeMeta } from "@/components/ui/data-table";

export interface TransactionAmountData {
  amount: number;
  currency: string;
}

interface FileTableProps {
  files: TaxFile[];
  /** Total count of all files before filtering (for empty state logic) */
  allFilesCount?: number;
  /** Count of displayed files that are not marked as not-invoice (for the toolbar counter) */
  invoiceCount?: number;
  /** Loading state - when true, empty states are not shown to prevent flicker */
  loading?: boolean;
  onSelectFile: (file: TaxFile) => void;
  selectedFileId?: string | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: FileFilters;
  onFiltersChange: (filters: FileFilters) => void;
  userPartners: UserPartner[];
  globalPartners: GlobalPartner[];
  transactionAmountsMap?: Map<string, TransactionAmountData[]>;
  // Multi-select props
  enableMultiSelect?: boolean;
  selectedRowIds?: Set<string>;
  /**
   * What the checkbox column shows ticked. Browsing a File (a plain click)
   * highlights its row but leaves its box empty (#517); defaults to
   * `selectedRowIds`.
   */
  checkedRowIds?: FileTableProps["selectedRowIds"];
  onSelectionChange?: (selectedIds: Set<string>, meta: SelectionChangeMeta) => void;
  /** Callback with the row ids in displayed order (filtered rows, active sort) */
  onDisplayedOrderChange?: (orderedIds: string[]) => void;
  /** Checkbox column: toggling a single row's checkbox (independent of modifier-click) */
  onToggleFileSelection?: (fileId: string, checked: boolean) => void;
  /** Checkbox column: toggling the header select-all checkbox */
  onToggleSelectAll?: () => void;
  /** Checkbox column: checked/unchecked/indeterminate state for the header checkbox */
  selectAllState?: SelectAllCheckedState;
  /** Callback to trigger file upload dialog */
  onUploadClick?: () => void;
  /** Callback to create an invoice (toolbar "New" menu) */
  onCreateInvoice?: () => void;
  creatingInvoice?: boolean;
}

export const FileTable = forwardRef<FilesDataTableHandle, FileTableProps>(
  function FileTable(
    {
      files,
      allFilesCount,
      invoiceCount,
      loading,
      onSelectFile,
      selectedFileId,
      searchValue,
      onSearchChange,
      filters,
      onFiltersChange,
      userPartners,
      globalPartners,
      transactionAmountsMap,
      enableMultiSelect,
      selectedRowIds,
      checkedRowIds,
      onSelectionChange,
      onDisplayedOrderChange,
      onToggleFileSelection,
      onToggleSelectAll,
      selectAllState = "unchecked",
      onUploadClick,
      onCreateInvoice,
      creatingInvoice,
    },
    ref
  ) {
    const router = useRouter();
    const convert = useEcbConverter();
    const { runningFileIds } = useRunningWorkers();

    // The deleted-files view (#268): same table, same filters, deleted rows
    // shown instead of hidden, a Deleted column, and Purge in the bulk bar.
    const deletedView = filters.deletedOnly === true;

    const selectionColumn: ColumnDef<TaxFile> = useMemo(
      () => ({
        id: "select",
        size: SELECT_COLUMN_WIDTH,
        minSize: SELECT_COLUMN_WIDTH,
        maxSize: SELECT_COLUMN_WIDTH,
        enableResizing: false,
        header: () => (
          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selectAllState === "indeterminate" ? "indeterminate" : selectAllState === "checked"}
              onCheckedChange={() => onToggleSelectAll?.()}
              aria-label="Select all files"
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={(checkedRowIds ?? selectedRowIds)?.has(row.original.id) ?? false}
              onCheckedChange={(checked) => onToggleFileSelection?.(row.original.id, checked === true)}
              aria-label={`Select ${row.original.fileName}`}
            />
          </div>
        ),
      }),
      [selectAllState, checkedRowIds, selectedRowIds, onToggleFileSelection, onToggleSelectAll]
    );

    const dataColumns = useMemo(
      () => getFileColumns(userPartners, globalPartners, transactionAmountsMap, undefined, runningFileIds, convert, deletedView),
      [userPartners, globalPartners, transactionAmountsMap, runningFileIds, convert, deletedView]
    );

    const columns = useMemo(
      () => (enableMultiSelect ? [selectionColumn, ...dataColumns] : dataColumns),
      [enableMultiSelect, selectionColumn, dataColumns]
    );

    // Calculate connected count (files connected to at least one transaction)
    const connectedCount = useMemo(
      () =>
        files.filter((file) => file.transactionIds && file.transactionIds.length > 0)
          .length,
      [files]
    );
    // Toolbar total counts invoices only; not-invoice files never inflate it.
    const totalCount = invoiceCount ?? files.filter((f) => !f.isNotInvoice).length;

    // Determine which empty state to show
    const totalUnfilteredCount = allFilesCount ?? files.length;
    const hasAnyFilters = searchValue || filters.extractedDateFrom || filters.extractedDateTo ||
      filters.hasConnections !== undefined || filters.amountType || filters.partnerIds?.length ||
      filters.hasPartner !== undefined ||
      filters.extractionComplete !== undefined || filters.documentTypes !== undefined || filters.deletedOnly;

    const emptyState = useMemo(() => {
      // Don't show empty state while still loading - prevents flicker
      if (loading) {
        return null;
      }
      if (totalUnfilteredCount === 0) {
        // No files at all
        return (
          <TableEmptyState
            icon={<FileText className="h-full w-full" />}
            title={emptyStatePresets.files.noData.title}
            description={emptyStatePresets.files.noData.description}
            action={onUploadClick ? {
              label: emptyStatePresets.files.noData.actionLabel!,
              onClick: onUploadClick,
              icon: <Upload className="h-4 w-4" />,
            } : undefined}
          />
        );
      }
      // Has files but filters returned nothing. Without a search term the
      // preset's "match your search" reads wrong — a filter hid them.
      return (
        <TableEmptyState
          icon={<Search className="h-full w-full" />}
          title={
            searchValue
              ? emptyStatePresets.files.noResults.title
              : "No files match these filters"
          }
          description={emptyStatePresets.files.noResults.description}
          action={hasAnyFilters ? {
            label: emptyStatePresets.files.noResults.actionLabel!,
            onClick: () => router.push("/files"),
          } : undefined}
          size="sm"
        />
      );
    }, [loading, totalUnfilteredCount, hasAnyFilters, searchValue, router, onUploadClick]);

    return (
      <div className="h-full flex flex-col overflow-hidden bg-card">
        <FileToolbar
          searchValue={searchValue}
          onSearchChange={onSearchChange}
          filters={filters}
          onFiltersChange={onFiltersChange}
          userPartners={userPartners}
          connectedCount={connectedCount}
          totalCount={totalCount}
          onUploadClick={onUploadClick}
          onCreateInvoice={onCreateInvoice}
          creatingInvoice={creatingInvoice}
        />
        <div className="flex-1 relative overflow-hidden flex flex-col">
          <FilesDataTable
            // Remount on view switch so the deleted view opens sorted by when
            // each File was deleted, newest first.
            key={deletedView ? "deleted" : "live"}
            ref={ref}
            columns={columns}
            data={files}
            initialSorting={deletedView ? [{ id: "deletedAt", desc: true }] : undefined}
            onRowClick={onSelectFile}
            selectedRowId={selectedFileId}
            enableMultiSelect={enableMultiSelect}
            selectedRowIds={selectedRowIds}
            onSelectionChange={onSelectionChange}
            onDisplayedOrderChange={onDisplayedOrderChange}
            emptyState={emptyState}
            searchingFileIds={runningFileIds}
          />
        </div>
      </div>
    );
  }
);
