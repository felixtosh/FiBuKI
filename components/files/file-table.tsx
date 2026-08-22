"use client";

import { useMemo, forwardRef } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { Loader2, Mail, FileText, Search, Upload } from "lucide-react";
import { FilesDataTable, FilesDataTableHandle } from "./files-data-table";
import { FileToolbar } from "./file-toolbar";
import { getFileColumns } from "./file-columns";
import { FileBulkActionBar } from "./file-bulk-action-bar";
import { Checkbox } from "@/components/ui/checkbox";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import { TaxFile, FileFilters } from "@/types/file";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { useGmailSyncStatus } from "@/hooks/use-gmail-sync-status";
import { useRunningWorkers } from "@/hooks/use-running-workers";
import { SelectAllCheckedState } from "@/lib/selection/bulk-file-selection";

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
  onSelectionChange?: (selectedIds: Set<string>) => void;
  /** Callback with the row ids in displayed order (filtered rows, active sort) */
  onDisplayedOrderChange?: (orderedIds: string[]) => void;
  /** Checkbox column: toggling a single row's checkbox (independent of modifier-click) */
  onToggleFileSelection?: (fileId: string, checked: boolean) => void;
  /** Checkbox column: toggling the header select-all checkbox */
  onToggleSelectAll?: () => void;
  /** Checkbox column: checked/unchecked/indeterminate state for the header checkbox */
  selectAllState?: SelectAllCheckedState;
  /** Floating bulk-action bar, shown above the table when a bulk selection is active */
  bulkActionBar?: {
    selectedCount: number;
    visible: boolean;
    onMarkAsNotInvoice: () => void;
    onMarkAsInvoice: () => void;
    onDelete: () => void;
    onClearSelection: () => void;
    isDeleting?: boolean;
    isUpdating?: boolean;
    progress?: { completed: number; total: number } | null;
  };
  /** Callback to trigger file upload dialog */
  onUploadClick?: () => void;
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
      onSelectionChange,
      onDisplayedOrderChange,
      onToggleFileSelection,
      onToggleSelectAll,
      selectAllState = "unchecked",
      bulkActionBar,
      onUploadClick,
    },
    ref
  ) {
    const router = useRouter();
    const { runningFileIds } = useRunningWorkers();

    const selectionColumn: ColumnDef<TaxFile> = useMemo(
      () => ({
        id: "select",
        size: 36,
        minSize: 36,
        maxSize: 36,
        enableResizing: false,
        header: () => (
          <div onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selectAllState === "indeterminate" ? "indeterminate" : selectAllState === "checked"}
              onCheckedChange={() => onToggleSelectAll?.()}
              aria-label="Select all files"
            />
          </div>
        ),
        cell: ({ row }) => (
          <div onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={selectedRowIds?.has(row.original.id) ?? false}
              onCheckedChange={(checked) => onToggleFileSelection?.(row.original.id, checked === true)}
              aria-label={`Select ${row.original.fileName}`}
            />
          </div>
        ),
      }),
      [selectAllState, selectedRowIds, onToggleFileSelection, onToggleSelectAll]
    );

    const dataColumns = useMemo(
      () => getFileColumns(userPartners, globalPartners, transactionAmountsMap, undefined, runningFileIds),
      [userPartners, globalPartners, transactionAmountsMap, runningFileIds]
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
      filters.extractionComplete !== undefined || filters.isNotInvoice !== undefined || filters.includeDeleted;

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

    const syncStatus = useGmailSyncStatus();

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
        />
        {/* Gmail sync progress indicator */}
        {syncStatus.isActive && (
          <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 dark:bg-blue-950/30 border-b text-sm text-blue-700 dark:text-blue-300">
            <Loader2 className="h-4 w-4 animate-spin" />
            <Mail className="h-4 w-4" />
            <span>
              Syncing from Gmail
              {syncStatus.filesCreated !== undefined && syncStatus.filesCreated > 0 && (
                <span className="text-muted-foreground ml-1">
                  ({syncStatus.filesCreated} files imported)
                </span>
              )}
            </span>
          </div>
        )}
        <div className="flex-1 relative overflow-hidden flex flex-col">
          {bulkActionBar?.visible && (
            <FileBulkActionBar
              selectedCount={bulkActionBar.selectedCount}
              onMarkAsNotInvoice={bulkActionBar.onMarkAsNotInvoice}
              onMarkAsInvoice={bulkActionBar.onMarkAsInvoice}
              onDelete={bulkActionBar.onDelete}
              onClearSelection={bulkActionBar.onClearSelection}
              isDeleting={bulkActionBar.isDeleting}
              isUpdating={bulkActionBar.isUpdating}
              progress={bulkActionBar.progress}
            />
          )}
          <FilesDataTable
            ref={ref}
            columns={columns}
            data={files}
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
