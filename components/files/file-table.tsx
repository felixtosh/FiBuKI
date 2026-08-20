"use client";

import { useMemo, forwardRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail, FileText, Search, Upload } from "lucide-react";
import { FilesDataTable, FilesDataTableHandle } from "./files-data-table";
import { FileToolbar } from "./file-toolbar";
import { getFileColumns } from "./file-columns";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import { TaxFile, FileFilters } from "@/types/file";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { useGmailSyncStatus } from "@/hooks/use-gmail-sync-status";
import { useRunningWorkers } from "@/hooks/use-running-workers";

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
      onUploadClick,
    },
    ref
  ) {
    const router = useRouter();
    const { runningFileIds } = useRunningWorkers();

    const columns = useMemo(
      () => getFileColumns(userPartners, globalPartners, transactionAmountsMap, undefined, runningFileIds),
      [userPartners, globalPartners, transactionAmountsMap, runningFileIds]
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
      filters.extractionComplete !== undefined || filters.isNotInvoice || filters.includeDeleted;

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
      // Has files but filters returned nothing
      return (
        <TableEmptyState
          icon={<Search className="h-full w-full" />}
          title={emptyStatePresets.files.noResults.title}
          description={emptyStatePresets.files.noResults.description}
          action={hasAnyFilters ? {
            label: emptyStatePresets.files.noResults.actionLabel!,
            onClick: () => router.push("/files"),
          } : undefined}
          size="sm"
        />
      );
    }, [loading, totalUnfilteredCount, hasAnyFilters, router, onUploadClick]);

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
        <FilesDataTable
          ref={ref}
          columns={columns}
          data={files}
          onRowClick={onSelectFile}
          selectedRowId={selectedFileId}
          enableMultiSelect={enableMultiSelect}
          selectedRowIds={selectedRowIds}
          onSelectionChange={onSelectionChange}
          emptyState={emptyState}
          searchingFileIds={runningFileIds}
        />
      </div>
    );
  }
);
