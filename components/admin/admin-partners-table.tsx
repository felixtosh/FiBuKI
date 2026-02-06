"use client";

import * as React from "react";
import { useState, useMemo, forwardRef } from "react";
import { GlobalPartner, PromotionCandidate } from "@/types/partner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SearchButton } from "@/components/ui/search-button";
import {
  ResizableDataTable,
  DataTableHandle,
  DataTableSection,
} from "@/components/ui/data-table";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Plus,
  Globe,
  Building2,
  RefreshCw,
  Database,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PRESET_PARTNERS_COUNT } from "@/lib/data/preset-partners";
import {
  AdminPartnerRow,
  CandidateMatch,
  findCandidateMatches,
  getAdminPartnerColumns,
  DEFAULT_ADMIN_PARTNER_COLUMN_SIZES,
} from "./admin-partners-columns";

// Re-export for consumers
export type { CandidateMatch } from "./admin-partners-columns";

interface AdminPartnersTableProps {
  globalPartners: GlobalPartner[];
  candidates: PromotionCandidate[];
  loading: boolean;
  onAdd: () => void;
  onApprove: (candidateId: string) => Promise<void>;
  onReject: (candidateId: string) => Promise<void>;
  onRowClick?: (partner: GlobalPartner) => void;
  onCandidateClick?: (candidate: PromotionCandidate, match: CandidateMatch | null) => void;
  selectedRowId?: string | null;
  selectedCandidateId?: string | null;
  onGenerateCandidates?: () => Promise<{ candidatesCreated: number; message: string }>;
  searchValue: string;
  onSearchChange: (value: string) => void;
  presetPartnersEnabled?: boolean;
  presetPartnersLoading?: boolean;
  onTogglePresetPartners?: (enable: boolean) => Promise<{ enabled: boolean; count: number }>;
}

export interface AdminPartnersTableHandle {
  scrollToIndex: (index: number) => void;
}

function AdminPartnersTableInner(
  {
    globalPartners,
    candidates,
    loading,
    onAdd,
    onApprove,
    onReject,
    onRowClick,
    onCandidateClick,
    selectedRowId,
    selectedCandidateId,
    onGenerateCandidates,
    searchValue,
    onSearchChange,
    presetPartnersEnabled,
    presetPartnersLoading,
    onTogglePresetPartners,
  }: AdminPartnersTableProps,
  ref: React.ForwardedRef<AdminPartnersTableHandle>
) {
  const [isGenerating, setIsGenerating] = useState(false);
  const tableRef = React.useRef<DataTableHandle>(null);

  // Forward ref
  React.useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => {
      tableRef.current?.scrollToIndex(index);
    },
  }), []);

  const handleTogglePresetPartners = async () => {
    if (!onTogglePresetPartners) return;
    await onTogglePresetPartners(!presetPartnersEnabled);
  };

  const handleGenerateCandidates = async () => {
    if (!onGenerateCandidates) return;
    setIsGenerating(true);
    try {
      const result = await onGenerateCandidates();
      console.log(result.message);
    } catch (error) {
      console.error("Failed to generate candidates:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  // Compute matches for all candidates
  const candidateMatchesMap = useMemo(() => {
    const map = new Map<string, CandidateMatch | null>();
    for (const candidate of candidates) {
      map.set(candidate.id, findCandidateMatches(candidate.userPartner, globalPartners));
    }
    return map;
  }, [candidates, globalPartners]);

  // Filter partners and candidates based on search
  const filteredPartners = useMemo(() => {
    if (!searchValue) return globalPartners;
    const search = searchValue.toLowerCase();
    return globalPartners.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.aliases.some((a) => a.toLowerCase().includes(search)) ||
        p.vatId?.toLowerCase().includes(search) ||
        p.ibans.some((i) => i.toLowerCase().includes(search)) ||
        p.website?.toLowerCase().includes(search)
    );
  }, [globalPartners, searchValue]);

  const filteredCandidates = useMemo(() => {
    if (!searchValue) return candidates;
    const search = searchValue.toLowerCase();
    return candidates.filter(
      (c) =>
        c.userPartner.name.toLowerCase().includes(search) ||
        c.userPartner.aliases.some((a) => a.toLowerCase().includes(search)) ||
        c.userPartner.vatId?.toLowerCase().includes(search) ||
        c.userPartner.ibans.some((i) => i.toLowerCase().includes(search))
    );
  }, [candidates, searchValue]);

  // Create unified rows for candidates
  const candidateRows: AdminPartnerRow[] = useMemo(() => {
    return filteredCandidates.map((candidate) => ({
      type: "candidate" as const,
      data: candidate,
      match: candidateMatchesMap.get(candidate.id) ?? null,
      // Add id for TanStack table
      id: `candidate-${candidate.id}`,
    }));
  }, [filteredCandidates, candidateMatchesMap]);

  // Create unified rows for partners
  const partnerRows: AdminPartnerRow[] = useMemo(() => {
    return filteredPartners.map((partner) => ({
      type: "partner" as const,
      data: partner,
      // Add id for TanStack table
      id: `partner-${partner.id}`,
    }));
  }, [filteredPartners]);

  // Create sections
  const sections: DataTableSection<AdminPartnerRow>[] = useMemo(() => {
    const result: DataTableSection<AdminPartnerRow>[] = [];

    if (candidateRows.length > 0) {
      result.push({
        id: "candidates",
        title: (
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            <Building2 className="h-4 w-4" />
            <span>Pending Suggestions</span>
            <Badge variant="secondary" className="text-xs bg-amber-200 text-amber-900 dark:bg-amber-800/50 dark:text-amber-200">
              {candidateRows.length}
            </Badge>
          </div>
        ),
        data: candidateRows,
        headerClassName: "bg-amber-100/70 dark:bg-amber-900/30 border-b",
        rowClassName: "bg-amber-50/30 dark:bg-amber-950/10 hover:bg-amber-100/50 dark:hover:bg-amber-950/20",
      });
    }

    if (partnerRows.length > 0) {
      result.push({
        id: "partners",
        title: (
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Globe className="h-4 w-4" />
            <span>Global Partners</span>
            <Badge variant="secondary" className="text-xs">
              {partnerRows.length}
            </Badge>
          </div>
        ),
        data: partnerRows,
        headerClassName: "bg-muted/50 border-y",
      });
    }

    return result;
  }, [candidateRows, partnerRows]);

  // Column definitions with actions
  const columns = useMemo(
    () => getAdminPartnerColumns({ onApprove, onReject }),
    [onApprove, onReject]
  );

  // Handle row click - dispatch to appropriate handler
  const handleRowClick = React.useCallback(
    (row: AdminPartnerRow) => {
      if (row.type === "candidate") {
        onCandidateClick?.(row.data, row.match);
      } else {
        onRowClick?.(row.data);
      }
    },
    [onRowClick, onCandidateClick]
  );

  // Get selected row ID
  const selectedId = useMemo(() => {
    if (selectedCandidateId) return `candidate-${selectedCandidateId}`;
    if (selectedRowId) return `partner-${selectedRowId}`;
    return null;
  }, [selectedRowId, selectedCandidateId]);

  // Get row data attributes
  const getRowDataAttributes = React.useCallback((row: AdminPartnerRow): Record<string, string> => {
    if (row.type === "candidate") {
      return { "candidate-id": row.data.id };
    }
    return { "partner-id": row.data.id };
  }, []);

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
              <Skeleton className="h-4 w-[100px]" />
              <Skeleton className="h-4 w-[100px]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full overflow-hidden bg-background">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
          <SearchButton
            value={searchValue}
            onSearch={onSearchChange}
            placeholder="Search partners..."
          />

          <div className="flex-1" />

          {onGenerateCandidates && (
            <Button
              onClick={handleGenerateCandidates}
              size="sm"
              variant="outline"
              disabled={isGenerating}
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", isGenerating && "animate-spin")} />
              {isGenerating ? "Scanning..." : "Find Suggestions"}
            </Button>
          )}

          {onTogglePresetPartners && (
            <Button
              onClick={handleTogglePresetPartners}
              size="sm"
              variant={presetPartnersEnabled ? "destructive" : "outline"}
              disabled={presetPartnersLoading}
            >
              <Database className={cn("h-4 w-4 mr-2", presetPartnersLoading && "animate-pulse")} />
              {presetPartnersLoading
                ? "Loading..."
                : presetPartnersEnabled
                ? "Disable Presets"
                : `Enable Presets (${PRESET_PARTNERS_COUNT})`}
            </Button>
          )}

          <Button onClick={onAdd} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Add Partner
          </Button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-hidden">
          <ResizableDataTable
            ref={tableRef}
            columns={columns}
            sections={sections}
            onRowClick={handleRowClick}
            selectedRowId={selectedId}
            defaultColumnSizes={DEFAULT_ADMIN_PARTNER_COLUMN_SIZES}
            getRowDataAttributes={getRowDataAttributes}
            emptyMessage={searchValue ? "No partners match your search" : "No global partners yet"}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

export const AdminPartnersTable = forwardRef(AdminPartnersTableInner);
