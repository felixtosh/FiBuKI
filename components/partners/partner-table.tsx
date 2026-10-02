"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Users, Search, Plus } from "lucide-react";
import { usePartners } from "@/hooks/use-partners";
import { useUserData } from "@/hooks/use-user-data";
import { PartnerToolbar } from "./partner-toolbar";
import { PartnerDataTable } from "./partner-data-table";
import { AddPartnerDialog } from "./add-partner-dialog";
import { TableEmptyState, emptyStatePresets } from "@/components/ui/table-empty-state";
import { UserPartner, PartnerFormData, PartnerFilters } from "@/types/partner";
import { isRecurringPartner } from "@/lib/partners/billing-cycle-presentation";
import { Skeleton } from "@/components/ui/skeleton";
import { SelectionChangeMeta } from "@/components/ui/data-table";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import {
  getSelectAllCheckedState,
  resolveSelectionChange,
  toggleFileCheckbox,
  toggleSelectAll,
} from "@/lib/selection/bulk-file-selection";

type IdSet = Set<string>;

interface PartnerTableProps {
  /** The Partner open in the detail panel (?id=), or null. */
  selectedPartnerId?: string | null;
  /** Opens a Partner in the detail panel, or closes it with null. */
  onPrimaryChange: (partnerId: string | null) => void;
  /**
   * The bulk selection besides the browsed Partner (#524), the same model as
   * the Files page: a plain click browses, checkboxes and cmd/shift-click
   * build the bulk selection, and the sidebar shows the bulk panel while it
   * is non-empty.
   */
  additionalSelectedIds: IdSet;
  onAdditionalSelectedIdsChange: (ids: IdSet) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: PartnerFilters;
  onFiltersChange: (filters: PartnerFilters) => void;
}

/** Nothing ticked while only browsing (#524). */
const NO_PARTNER_IDS: string[] = [];

export function PartnerTable({
  selectedPartnerId = null,
  onPrimaryChange,
  additionalSelectedIds,
  onAdditionalSelectedIdsChange,
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
}: PartnerTableProps) {
  const router = useRouter();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const { partners, loading, error, createPartner } = usePartners();
  const { markedAsMe } = useUserData();

  // Filter partners by search and filters
  const filteredPartners = useMemo(() => {
    let data = partners;

    // Apply search filter
    if (searchValue) {
      const search = searchValue.toLowerCase();
      data = data.filter(
        (p) =>
          p.name.toLowerCase().includes(search) ||
          p.aliases.some((a) => a.toLowerCase().includes(search)) ||
          p.vatId?.toLowerCase().includes(search) ||
          p.ibans.some((i) => i.toLowerCase().includes(search)) ||
          p.website?.toLowerCase().includes(search)
      );
    }

    // Apply VAT ID filter
    if (filters.hasVatId !== undefined) {
      data = data.filter((p) =>
        filters.hasVatId ? !!p.vatId : !p.vatId
      );
    }

    // Apply IBAN filter
    if (filters.hasIban !== undefined) {
      data = data.filter((p) =>
        filters.hasIban ? p.ibans.length > 0 : p.ibans.length === 0
      );
    }

    // Apply recurring filter
    if (filters.isRecurring !== undefined) {
      data = data.filter((p) =>
        filters.isRecurring ? isRecurringPartner(p) : !isRecurringPartner(p)
      );
    }

    // Apply country filter
    if (filters.country) {
      data = data.filter((p) => p.country === filters.country);
    }

    return data;
  }, [partners, searchValue, filters]);

  const bulkActive = additionalSelectedIds.size > 0;
  const allSelectedIds = useMemo(() => {
    const all = new Set(additionalSelectedIds);
    if (selectedPartnerId) all.add(selectedPartnerId);
    return all;
  }, [additionalSelectedIds, selectedPartnerId]);
  // A browsed Partner is highlighted, not ticked, until a bulk selection exists.
  const checkedIds = useMemo(
    () => (bulkActive ? allSelectedIds : new Set(NO_PARTNER_IDS)),
    [bulkActive, allSelectedIds]
  );
  const displayedIds = useMemo(() => filteredPartners.map((p) => p.id), [filteredPartners]);

  const selectAllState = useMemo(() => {
    const state = getSelectAllCheckedState({ displayedFileIds: displayedIds, selectedIds: checkedIds });
    return state === "indeterminate" ? ("indeterminate" as const) : state === "checked";
  }, [displayedIds, checkedIds]);

  // Live closure: the memoised rows keep the handler they last painted with (#232).
  const handleToggleRow = useLatestCallback((partnerId: string, checked: boolean) => {
    const result = toggleFileCheckbox({
      fileId: partnerId,
      checked,
      primarySelectedId: selectedPartnerId,
      additionalSelectedIds,
    });
    onAdditionalSelectedIdsChange(result.additionalSelectedIds);
    if (result.closePrimary) onPrimaryChange(null);
  });

  const handleToggleSelectAll = () => {
    const result = toggleSelectAll({
      displayedFileIds: displayedIds,
      primarySelectedId: bulkActive ? selectedPartnerId : null,
      additionalSelectedIds,
    });
    onAdditionalSelectedIdsChange(result.additionalSelectedIds);
    if (result.closePrimary || (!bulkActive && result.additionalSelectedIds.size > 0)) {
      onPrimaryChange(null);
    }
  };

  const handleSelectionChange = useLatestCallback(
    (newSelectedIds: Set<string>, meta: SelectionChangeMeta) => {
      const result = resolveSelectionChange({
        newSelectedIds,
        isPlainClick: meta.isPlainClick,
        primarySelectedId: selectedPartnerId,
        clickedRowId: meta.clickedRowId,
        isRangeClick: meta.isRangeClick,
      });
      onAdditionalSelectedIdsChange(result.additionalSelectedIds);
      if (result.primaryId !== selectedPartnerId) onPrimaryChange(result.primaryId);
    }
  );

  // Determine which empty state to show
  const hasAnyFilters = searchValue || filters.hasVatId !== undefined ||
    filters.hasIban !== undefined || filters.isRecurring !== undefined ||
    filters.country;

  const emptyState = useMemo(() => {
    // Don't show empty state while still loading - prevents flicker
    // Note: loading check is already done above, but this is a safeguard
    // for the useMemo dependency to ensure proper state
    if (loading) {
      return null;
    }
    if (partners.length === 0) {
      // No partners at all
      return (
        <TableEmptyState
          icon={<Users className="h-full w-full" />}
          title={emptyStatePresets.partners.noData.title}
          description={emptyStatePresets.partners.noData.description}
          action={{
            label: emptyStatePresets.partners.noData.actionLabel!,
            onClick: () => setIsAddDialogOpen(true),
            icon: <Plus className="h-4 w-4" />,
          }}
        />
      );
    }
    // Has partners but filters returned nothing
    return (
      <TableEmptyState
        icon={<Search className="h-full w-full" />}
        title={emptyStatePresets.partners.noResults.title}
        description={emptyStatePresets.partners.noResults.description}
        action={hasAnyFilters ? {
          label: emptyStatePresets.partners.noResults.actionLabel!,
          onClick: () => router.push("/partners"),
        } : undefined}
        size="sm"
      />
    );
  }, [loading, partners.length, hasAnyFilters, router]);

  const handleAddPartner = async (data: PartnerFormData) => {
    return createPartner(data);
  };



  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
          <Skeleton className="h-9 w-[300px]" />
          <Skeleton className="h-9 w-[120px]" />
        </div>
        <div className="flex-1">
          {[...Array(10)].map((_, i) => (
            <div
              key={i}
              className="flex items-center space-x-4 px-4 py-3 border-b last:border-b-0"
            >
              <Skeleton className="h-4 w-[200px]" />
              <Skeleton className="h-4 w-[100px]" />
              <Skeleton className="h-4 w-[180px]" />
              <Skeleton className="h-4 w-[120px]" />
              <Skeleton className="h-4 w-[24px]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-10">
        <p className="text-destructive mb-2">Error loading partners</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      <PartnerToolbar
        searchValue={searchValue}
        onSearchChange={onSearchChange}
        filters={filters}
        onFiltersChange={onFiltersChange}
        onAddPartner={() => setIsAddDialogOpen(true)}
      />

      <div className="flex-1 relative overflow-hidden flex flex-col">
        <PartnerDataTable
          data={filteredPartners}
          selectedRowId={selectedPartnerId}
          markedAsMe={markedAsMe}
          emptyState={emptyState}
          selectedRowIds={allSelectedIds}
          checkedRowIds={checkedIds}
          onSelectionChange={handleSelectionChange}
          onToggleRow={handleToggleRow}
          onToggleSelectAll={handleToggleSelectAll}
          selectAllState={selectAllState}
        />
      </div>

      <AddPartnerDialog
        open={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        onAdd={handleAddPartner}
      />

    </div>
  );
}
