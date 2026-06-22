"use client";

import { Suspense, useState, useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CategoryTable } from "@/components/categories/category-table";
import { CategoryDetailPanel } from "@/components/categories/category-detail-panel";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
import { Skeleton } from "@/components/ui/skeleton";
import { UserNoReceiptCategory } from "@/types/no-receipt-category";
import { cn } from "@/lib/utils";

const PANEL_WIDTH_KEY = "categoryDetailPanelWidth";
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 700;

function CategoryTableFallback() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <Skeleton className="h-9 w-[300px]" />
      </div>
      <div className="flex-1">
        {[...Array(9)].map((_, i) => (
          <div
            key={i}
            className="flex items-center space-x-4 px-4 py-3 border-b last:border-b-0"
          >
            <Skeleton className="h-4 w-[200px]" />
            <Skeleton className="h-4 w-[100px]" />
            <Skeleton className="h-4 w-[80px]" />
            <Skeleton className="h-4 w-[80px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoriesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { categories, loading } = useNoReceiptCategories();

  const [panelWidth, setPanelWidth] = useState<number>(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Get selected category ID and search value from URL
  const selectedId = searchParams.get("id");
  const searchValue = searchParams.get("search") || "";

  // Update search in URL
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      const newUrl = params.toString() ? `/settings/categories?${params.toString()}` : "/settings/categories";
      router.replace(newUrl, { scroll: false });
    },
    [router, searchParams]
  );

  // Find selected category
  const selectedCategory = categories.find((c) => c.id === selectedId) || null;

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

  // Select category (update URL)
  const handleSelectCategory = useCallback(
    (category: UserNoReceiptCategory) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("id", category.id);
      router.push(`/settings/categories?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  // Close detail panel (remove ID from URL)
  const handleCloseDetail = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("id");
    const newUrl = params.toString()
      ? `/settings/categories?${params.toString()}`
      : "/settings/categories";
    router.push(newUrl, { scroll: false });
  }, [router, searchParams]);

  if (loading) {
    return <CategoryTableFallback />;
  }

  return (
    <div className="h-full overflow-hidden">
      {/* Main content - adjusts margin when panel is open */}
      <div
        className="h-full transition-[margin] duration-200 ease-in-out"
        style={{ marginRight: selectedCategory ? panelWidth : 0 }}
      >
        <CategoryTable
          onSelectCategory={handleSelectCategory}
          selectedCategoryId={selectedId}
          searchValue={searchValue}
          onSearchChange={handleSearchChange}
        />
      </div>

      {/* Right sidebar - fixed position */}
      {selectedCategory && (
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
            <CategoryDetailPanel
              category={selectedCategory}
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

export default function SettingsCategoriesPage() {
  return (
    <Suspense fallback={<CategoryTableFallback />}>
      <CategoriesContent />
    </Suspense>
  );
}
