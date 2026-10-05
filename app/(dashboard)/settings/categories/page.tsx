"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CategoryTable } from "@/components/categories/category-table";
import { CategoryDetailPanel } from "@/components/categories/category-detail-panel";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
import { Skeleton } from "@/components/ui/skeleton";
import { UserNoReceiptCategory } from "@/types/no-receipt-category";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";
import { pushQuery, replaceQuery } from "@/lib/navigation/query-url";

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
      replaceQuery(router, newUrl);
    },
    [router, searchParams]
  );

  // Find selected category
  const selectedCategory = categories.find((c) => c.id === selectedId) || null;

  // Select category (update URL)
  const handleSelectCategory = useCallback(
    (category: UserNoReceiptCategory) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("id", category.id);
      pushQuery(router, `/settings/categories?${params.toString()}`);
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
    pushQuery(router, newUrl);
  }, [router, searchParams]);

  if (loading) {
    return <CategoryTableFallback />;
  }

  return (
    <div className="h-full overflow-hidden">
      <DetailPanelLayout
        storageKey={PANEL_WIDTH_KEY}
        defaultWidth={DEFAULT_PANEL_WIDTH}
        minWidth={MIN_PANEL_WIDTH}
        maxWidth={MAX_PANEL_WIDTH}
        open={!!selectedCategory}
        panel={
          selectedCategory ? (
            <CategoryDetailPanel
              category={selectedCategory}
              onClose={handleCloseDetail}
            />
          ) : null
        }
      >
        <CategoryTable
          onSelectCategory={handleSelectCategory}
          selectedCategoryId={selectedId}
          searchValue={searchValue}
          onSearchChange={handleSearchChange}
        />
      </DetailPanelLayout>
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
