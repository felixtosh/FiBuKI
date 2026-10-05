"use client";

import { useState, useCallback, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { AdminPartnersTable, CandidateMatch } from "@/components/admin/admin-partners-table";
import { AddGlobalPartnerDialog } from "@/components/admin/add-global-partner-dialog";
import { GlobalPartnerDetailPanel } from "@/components/admin/global-partner-detail-panel";
import { CandidateDetailPanel } from "@/components/admin/candidate-detail-panel";
import { GlobalPartner, GlobalPartnerFormData, PromotionCandidate } from "@/types/partner";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";
import { pushQuery, replaceQuery } from "@/lib/navigation/query-url";

const PANEL_WIDTH_KEY = "globalPartnerDetailPanelWidth";
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 700;

function AdminPartnersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    globalPartners,
    promotionCandidates,
    loading,
    createPartner,
    updatePartner,
    deletePartner,
    approveCandidate,
    rejectCandidate,
    generateCandidates,
    presetPartnersEnabled,
    presetPartnersLoading,
    togglePresetPartners,
  } = useGlobalPartners();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPartner, setEditingPartner] = useState<GlobalPartner | null>(null);

  // Selected candidate state (separate from URL-based global partner selection)
  const [selectedCandidate, setSelectedCandidate] = useState<{
    candidate: PromotionCandidate;
    match: CandidateMatch | null;
  } | null>(null);

  // Get selected partner ID and search value from URL
  const selectedId = searchParams.get("id");
  const selectedCandidateId = searchParams.get("candidateId");
  const searchValue = searchParams.get("search") || "";

  // Find selected partner
  const selectedPartner = useMemo(() => {
    if (!selectedId || !globalPartners.length) return null;
    return globalPartners.find((p) => p.id === selectedId) || null;
  }, [selectedId, globalPartners]);

  // Determine if panel should be shown
  const showPanel = selectedPartner || selectedCandidate;

  // Update search in URL
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      const newUrl = params.toString()
        ? `/admin/partners?${params.toString()}`
        : "/admin/partners";
      replaceQuery(router, newUrl);
    },
    [router, searchParams]
  );

  // Select partner (update URL)
  const handleSelectPartner = useCallback(
    (partner: GlobalPartner) => {
      // Clear candidate selection when selecting a partner
      setSelectedCandidate(null);
      const params = new URLSearchParams(searchParams.toString());
      params.set("id", partner.id);
      params.delete("candidateId");
      pushQuery(router, `/admin/partners?${params.toString()}`);
    },
    [router, searchParams]
  );

  // Select candidate
  const handleSelectCandidate = useCallback(
    (candidate: PromotionCandidate, match: CandidateMatch | null) => {
      // Clear partner selection when selecting a candidate
      setSelectedCandidate({ candidate, match });
      const params = new URLSearchParams(searchParams.toString());
      params.delete("id");
      params.set("candidateId", candidate.id);
      pushQuery(router, `/admin/partners?${params.toString()}`);
    },
    [router, searchParams]
  );

  // Close detail panel (remove ID from URL)
  const handleCloseDetail = useCallback(() => {
    setSelectedCandidate(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("id");
    params.delete("candidateId");
    const newUrl = params.toString()
      ? `/admin/partners?${params.toString()}`
      : "/admin/partners";
    pushQuery(router, newUrl);
  }, [router, searchParams]);

  const handleAdd = () => {
    setEditingPartner(null);
    setIsDialogOpen(true);
  };

  const handleEdit = (partner: GlobalPartner) => {
    setEditingPartner(partner);
    setIsDialogOpen(true);
  };

  const handleSave = async (data: GlobalPartnerFormData) => {
    if (editingPartner) {
      await updatePartner(editingPartner.id, data);
    } else {
      return createPartner(data);
    }
  };

  const handleDelete = async (partnerId: string) => {
    if (confirm("Are you sure you want to delete this partner?")) {
      await deletePartner(partnerId);
      // Close panel if the deleted partner was selected
      if (selectedId === partnerId) {
        handleCloseDetail();
      }
    }
  };

  const handleApprove = async (candidateId: string) => {
    await approveCandidate(candidateId);
  };

  const handleReject = async (candidateId: string) => {
    if (confirm("Are you sure you want to reject this suggestion?")) {
      await rejectCandidate(candidateId);
    }
  };

  return (
    <div className="h-full overflow-hidden">
      <DetailPanelLayout
        storageKey={PANEL_WIDTH_KEY}
        defaultWidth={DEFAULT_PANEL_WIDTH}
        minWidth={MIN_PANEL_WIDTH}
        maxWidth={MAX_PANEL_WIDTH}
        open={!!showPanel}
        panel={
          selectedPartner ? (
            <GlobalPartnerDetailPanel
              partner={selectedPartner}
              onClose={handleCloseDetail}
            />
          ) : selectedCandidate ? (
            <CandidateDetailPanel
              candidate={selectedCandidate.candidate}
              match={selectedCandidate.match}
              onClose={handleCloseDetail}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ) : null
        }
      >
        <AdminPartnersTable
          globalPartners={globalPartners}
          candidates={promotionCandidates}
          loading={loading}
          onAdd={handleAdd}
          onApprove={handleApprove}
          onReject={handleReject}
          onRowClick={handleSelectPartner}
          onCandidateClick={handleSelectCandidate}
          selectedRowId={selectedId}
          selectedCandidateId={selectedCandidate?.candidate.id || null}
          onGenerateCandidates={generateCandidates}
          searchValue={searchValue}
          onSearchChange={handleSearchChange}
          presetPartnersEnabled={presetPartnersEnabled}
          presetPartnersLoading={presetPartnersLoading}
          onTogglePresetPartners={togglePresetPartners}
        />
      </DetailPanelLayout>

      <AddGlobalPartnerDialog
        open={isDialogOpen}
        onClose={() => {
          setIsDialogOpen(false);
          setEditingPartner(null);
        }}
        onSave={handleSave}
        editingPartner={editingPartner}
      />
    </div>
  );
}

function AdminPartnersFallback() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <Skeleton className="h-9 w-[300px]" />
        <Skeleton className="h-9 w-[100px]" />
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

export default function AdminPartnersPage() {
  return (
    <Suspense fallback={<AdminPartnersFallback />}>
      <AdminPartnersContent />
    </Suspense>
  );
}
