"use client";

import { useMemo } from "react";
import { useNoReceiptCategories } from "@/hooks/use-no-receipt-categories";
import { CategoryToolbar } from "./category-toolbar";
import { CategoryDataTable } from "./category-data-table";
import { UserNoReceiptCategory } from "@/types/no-receipt-category";
import { Skeleton } from "@/components/ui/skeleton";

interface CategoryTableProps {
  onSelectCategory?: (category: UserNoReceiptCategory) => void;
  selectedCategoryId?: string | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
}

export function CategoryTable({
  onSelectCategory,
  selectedCategoryId,
  searchValue,
  onSearchChange,
}: CategoryTableProps) {
  const { categories, loading, error } = useNoReceiptCategories();

  // Filter categories by search
  const filteredCategories = useMemo(() => {
    if (!searchValue) return categories;

    const search = searchValue.toLowerCase();
    return categories.filter(
      (c) =>
        c.name.toLowerCase().includes(search) ||
        c.description.toLowerCase().includes(search) ||
        c.helperText.toLowerCase().includes(search)
    );
  }, [categories, searchValue]);

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
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

  if (error) {
    return (
      <div className="text-center py-10">
        <p className="text-destructive mb-2">Error loading categories</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      <CategoryToolbar
        searchValue={searchValue}
        onSearchChange={onSearchChange}
      />

      <CategoryDataTable
        data={filteredCategories}
        onRowClick={onSelectCategory}
        selectedRowId={selectedCategoryId}
      />
    </div>
  );
}
