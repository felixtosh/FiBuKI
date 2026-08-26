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

interface PartnerTableProps {
  onSelectPartner?: (partner: UserPartner) => void;
  selectedPartnerId?: string | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: PartnerFilters;
  onFiltersChange: (filters: PartnerFilters) => void;
}

export function PartnerTable({
  onSelectPartner,
  selectedPartnerId,
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
}: PartnerTableProps) {
  const router = useRouter();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const { partners, loading, error, createPartner, deletePartner } = usePartners();
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

  const handleDeletePartner = async (partnerId: string) => {
    if (confirm("Are you sure you want to delete this partner?")) {
      await deletePartner(partnerId);
    }
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

      <PartnerDataTable
        data={filteredPartners}
        onRowClick={onSelectPartner}
        selectedRowId={selectedPartnerId}
        onDelete={handleDeletePartner}
        markedAsMe={markedAsMe}
        emptyState={emptyState}
      />

      <AddPartnerDialog
        open={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        onAdd={handleAddPartner}
      />
    </div>
  );
}
