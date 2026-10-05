"use client";

import { useRememberedListQuery } from "@/hooks/use-remembered-list-query";
import { Suspense, useState, useCallback, useMemo, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { PartnerTable } from "@/components/partners/partner-table";
import { PartnerDetailPanel } from "@/components/partners/partner-detail-panel";
import { useTranslations } from "next-intl";
import { PartnerBulkPanel } from "@/components/partners/partner-bulk-panel";
import { MergePartnersDialog } from "@/components/partners/merge-partners-dialog";
import { MergedPartnerNotice } from "@/components/partners/merged-partner-notice";
import { usePartners } from "@/hooks/use-partners";
import { Skeleton } from "@/components/ui/skeleton";
import { UserPartner, PartnerFilters } from "@/types/partner";
import { parsePartnerFiltersFromUrl, buildPartnerFilterUrl } from "@/lib/filters/partner-url-params";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";
import { usePageTitle } from "@/hooks/use-page-title";
import { SmartFeatureGuard, useAuth } from "@/components/auth";
import { pushQuery, replaceQuery } from "@/lib/navigation/query-url";

const PANEL_WIDTH_KEY = "partnerDetailPanelWidth";
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 700;

function PartnerTableFallback() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <Skeleton className="h-9 w-[300px]" />
        <Skeleton className="h-9 w-[100px]" />
      </div>
      <div className="flex-1">
        {[...Array(15)].map((_, i) => (
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

function PartnersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Filters survive a trip to another page (#530).
  useRememberedListQuery("partners", "/partners");
  const { userId } = useAuth();

  const { partners, loading, deletePartner } = usePartners();
  const tBulk = useTranslations("partners.bulk");


  // Get selected partner ID and search value from URL
  const selectedId = searchParams.get("id");
  const searchValue = searchParams.get("search") || "";

  // Parse filters from URL
  const filters = useMemo(
    () => parsePartnerFiltersFromUrl(searchParams),
    [searchParams]
  );

  // Update search in URL
  const handleSearchChange = useCallback(
    (value: string) => {
      const url = buildPartnerFilterUrl(filters, value, selectedId);
      replaceQuery(router, url);
    },
    [router, filters, selectedId]
  );

  // Update filters in URL
  const handleFiltersChange = useCallback(
    (newFilters: PartnerFilters) => {
      const url = buildPartnerFilterUrl(newFilters, searchValue, selectedId);
      pushQuery(router, url);
    },
    [router, searchValue, selectedId]
  );

  // The bulk selection besides the browsed Partner (#524). While it is
  // non-empty the sidebar shows the bulk panel instead of one Partner.
  const [additionalSelectedIds, setAdditionalSelectedIds] = useState<Set<string>>(new Set());
  const [isMergeDialogOpen, setIsMergeDialogOpen] = useState(false);
  const bulkActive = additionalSelectedIds.size > 0;
  const bulkIds = useMemo(() => {
    const ids = new Set(additionalSelectedIds);
    if (bulkActive && selectedId) ids.add(selectedId);
    return ids;
  }, [bulkActive, additionalSelectedIds, selectedId]);
  // One ticked Partner is still one Partner (#526): the sidebar shows its
  // details, and the bulk panel takes over from two.
  const singleCheckedId = bulkActive && bulkIds.size === 1 ? [...bulkIds][0] : null;
  const showBulkPanel = bulkActive && bulkIds.size >= 2;
  const bulkPartners = useMemo(
    () => (showBulkPanel ? partners.filter((p) => bulkIds.has(p.id)) : []),
    [showBulkPanel, bulkIds, partners]
  );

  // The Partner the detail panel is about: the browsed one (?id=) or the one
  // ticked Partner.
  const panelPartnerId = singleCheckedId ?? selectedId;
  const selectedPartner = useMemo(() => {
    if (!panelPartnerId || !partners.length) return null;
    return partners.find((p) => p.id === panelPartnerId) || null;
  }, [panelPartnerId, partners]);

  // Bulk delete (#526): every selected Partner, after one confirmation.
  const handleBulkDelete = useCallback(async () => {
    const ids = [...bulkIds];
    if (ids.length === 0 || !confirm(tBulk("deleteConfirm", { count: ids.length }))) return;
    for (const id of ids) await deletePartner(id);
    setAdditionalSelectedIds(new Set());
  }, [bulkIds, deletePartner, tBulk]);

  // Set page title
  usePageTitle("Partners", selectedPartner?.name);

  // An old link may still point at a Partner that has since been merged away.
  // The active-only query above never returns it, so a stale id has to be
  // looked up on its own to tell "merged" apart from "never existed" (#263 AC7).
  const [mergedAwaySurvivorId, setMergedAwaySurvivorId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId || loading || selectedPartner || !userId) {
      // Deferred so this reset runs event-handler-style, not synchronously
      // from within the effect body.
      queueMicrotask(() => setMergedAwaySurvivorId(null));
      return;
    }

    let cancelled = false;
    getDoc(doc(db, "partners", selectedId))
      .then((snapshot) => {
        if (cancelled) return;
        if (!snapshot.exists()) {
          setMergedAwaySurvivorId(null);
          return;
        }
        const data = snapshot.data();
        setMergedAwaySurvivorId(
          data.userId === userId && typeof data.mergedInto === "string" ? data.mergedInto : null
        );
      })
      .catch(() => {
        if (!cancelled) setMergedAwaySurvivorId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, loading, selectedPartner, userId]);

  // Open a Partner in the panel, or close it with null (the table's selection model)
  const handlePrimaryChange = useCallback(
    (partnerId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (partnerId) params.set("id", partnerId);
      else params.delete("id");
      const query = params.toString();
      pushQuery(router, query ? `/partners?${query}` : "/partners");
    },
    [router, searchParams]
  );

  // Close detail panel (remove ID from URL)
  const handleCloseDetail = useCallback(() => {
    // Closing the panel on the one ticked Partner unticks it too (#526).
    setAdditionalSelectedIds((prev) => (prev.size === 1 ? new Set() : prev));
    const params = new URLSearchParams(searchParams.toString());
    params.delete("id");
    const newUrl = params.toString()
      ? `/partners?${params.toString()}`
      : "/partners";
    pushQuery(router, newUrl);
  }, [router, searchParams]);

  // Open a partner by id (used to jump from a Merged Partner to its survivor)
  const handleOpenPartnerId = useCallback(
    (partnerId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("id", partnerId);
      pushQuery(router, `/partners?${params.toString()}`);
    },
    [router, searchParams]
  );

  if (loading) {
    return <PartnerTableFallback />;
  }

  const showMergedNotice = !bulkActive && !selectedPartner && !!mergedAwaySurvivorId;
  const showDetail = !showBulkPanel && !!selectedPartner;
  const sidebarOpen = showBulkPanel || showDetail || showMergedNotice;

  return (
    <div className="h-full overflow-hidden">
      <DetailPanelLayout
        storageKey={PANEL_WIDTH_KEY}
        defaultWidth={DEFAULT_PANEL_WIDTH}
        minWidth={MIN_PANEL_WIDTH}
        maxWidth={MAX_PANEL_WIDTH}
        open={sidebarOpen}
        panel={
          <>
            {showBulkPanel ? (
              <PartnerBulkPanel
                partners={bulkPartners}
                onMerge={() => setIsMergeDialogOpen(true)}
                onDelete={handleBulkDelete}
                onClearSelection={() => setAdditionalSelectedIds(new Set())}
              />
            ) : null}
            {showDetail && selectedPartner ? (
              <PartnerDetailPanel
                partner={selectedPartner}
                onClose={handleCloseDetail}
              />
            ) : null}
            {showMergedNotice ? (
              <MergedPartnerNotice
                survivorId={mergedAwaySurvivorId!}
                onOpenSurvivor={handleOpenPartnerId}
                onClose={handleCloseDetail}
              />
            ) : null}
          </>
        }
      >
        <PartnerTable
          selectedPartnerId={selectedId}
          onPrimaryChange={handlePrimaryChange}
          additionalSelectedIds={additionalSelectedIds}
          onAdditionalSelectedIdsChange={setAdditionalSelectedIds}
          searchValue={searchValue}
          onSearchChange={handleSearchChange}
          filters={filters}
          onFiltersChange={handleFiltersChange}
        />
      </DetailPanelLayout>

      <MergePartnersDialog
        open={isMergeDialogOpen}
        onClose={() => setIsMergeDialogOpen(false)}
        partners={bulkPartners}
        onMerged={() => setAdditionalSelectedIds(new Set())}
      />
    </div>
  );
}

export default function PartnersPage() {
  return (
    <SmartFeatureGuard feature="partnerIntelligence">
      <Suspense fallback={<PartnerTableFallback />}>
        <PartnersContent />
      </Suspense>
    </SmartFeatureGuard>
  );
}
