"use client";

import { Suspense, useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PartnerTable } from "@/components/partners/partner-table";
import { PartnerDetailPanel } from "@/components/partners/partner-detail-panel";
import { usePartners } from "@/hooks/use-partners";
import { Skeleton } from "@/components/ui/skeleton";
import { UserPartner, PartnerFilters } from "@/types/partner";
import { parsePartnerFiltersFromUrl, buildPartnerFilterUrl } from "@/lib/filters/partner-url-params";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { SmartFeatureGuard } from "@/components/auth";

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

  const { partners, loading } = usePartners();

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
      router.replace(url, { scroll: false });
    },
    [router, filters, selectedId]
  );

  // Update filters in URL
  const handleFiltersChange = useCallback(
    (newFilters: PartnerFilters) => {
      const url = buildPartnerFilterUrl(newFilters, searchValue, selectedId);
      router.push(url, { scroll: false });
    },
    [router, searchValue, selectedId]
  );

  // Find selected partner
  const selectedPartner = useMemo(() => {
    if (!selectedId || !partners.length) return null;
    return partners.find((p) => p.id === selectedId) || null;
  }, [selectedId, partners]);

  // Set page title
  usePageTitle("Partners", selectedPartner?.name);

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

  // Select partner (update URL)
  const handleSelectPartner = useCallback(
    (partner: UserPartner) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("id", partner.id);
      router.push(`/partners?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  // Close detail panel (remove ID from URL)
  const handleCloseDetail = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("id");
    const newUrl = params.toString()
      ? `/partners?${params.toString()}`
      : "/partners";
    router.push(newUrl, { scroll: false });
  }, [router, searchParams]);

  if (loading) {
    return <PartnerTableFallback />;
  }

  return (
    <div className="h-full overflow-hidden">
      {/* Main content - adjusts margin when panel is open */}
      <div
        className="h-full transition-[margin] duration-200 ease-in-out"
        style={{ marginRight: selectedPartner ? panelWidth : 0 }}
      >
        <PartnerTable
          onSelectPartner={handleSelectPartner}
          selectedPartnerId={selectedId}
          searchValue={searchValue}
          onSearchChange={handleSearchChange}
          filters={filters}
          onFiltersChange={handleFiltersChange}
        />
      </div>

      {/* Right sidebar - fixed position */}
      {selectedPartner && (
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
            <PartnerDetailPanel
              partner={selectedPartner}
              onClose={handleCloseDetail}
            />
          </div>
        </div>
      )}

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
