"use client";

import { Suspense, useState, useCallback, useMemo, useRef, useEffect } from "react";
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
import { cn } from "@/lib/utils";
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
  const { userId } = useAuth();

  const { partners, loading, deletePartner } = usePartners();
  const tBulk = useTranslations("partners.bulk");

  const [panelWidth, setPanelWidth] = useState<number>(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

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

  // Load panel width from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!saved) return;
    const parsed = parseInt(saved, 10);
    if (isNaN(parsed) || parsed < MIN_PANEL_WIDTH || parsed > MAX_PANEL_WIDTH) return;
    // Defer to microtask so setState runs event-handler-style, not from within the effect body.
    queueMicrotask(() => setPanelWidth(parsed));
  }, []);

  // Handle resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = { startX: e.clientX, startWidth: panelWidth };
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startX - e.clientX;
      const newWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, resizeRef.current.startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      localStorage.setItem(PANEL_WIDTH_KEY, panelWidth.toString());
      resizeRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, panelWidth]);

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
      {/* Main content - adjusts margin when panel is open */}
      <div
        className="h-full transition-[margin] duration-200 ease-in-out"
        style={{ marginRight: sidebarOpen ? panelWidth : 0 }}
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
      </div>

      {/* Right sidebar - fixed position */}
      {sidebarOpen && (
        <div
          className="fixed right-0 top-14 bottom-0 z-50 bg-background border-l flex"
          style={{ width: panelWidth }}
        >
          {/* Resize handle */}
          <div
            className={cn(
              "w-1 cursor-col-resize hover:bg-primary/20 transition-colors flex-shrink-0",
              isResizing && "bg-primary/30"
            )}
            onMouseDown={handleResizeStart}
          />
          {/* Panel content */}
          <div className="flex-1 overflow-hidden detail-panel-container">
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
          </div>
        </div>
      )}

      <MergePartnersDialog
        open={isMergeDialogOpen}
        onClose={() => setIsMergeDialogOpen(false)}
        partners={bulkPartners}
        onMerged={() => setAdditionalSelectedIds(new Set())}
      />

      {/* Prevent text selection while resizing */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
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
