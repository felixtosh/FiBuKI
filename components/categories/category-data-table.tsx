"use client";

import * as React from "react";
import { forwardRef } from "react";
import { UserNoReceiptCategory } from "@/types/no-receipt-category";
import {
  ResizableDataTable,
  DataTableHandle,
} from "@/components/ui/data-table";
import { getCategoryColumns } from "./category-columns";

interface CategoryDataTableProps {
  data: UserNoReceiptCategory[];
  onRowClick?: (category: UserNoReceiptCategory) => void;
  selectedRowId?: string | null;
}

export interface CategoryDataTableHandle {
  scrollToIndex: (index: number) => void;
}

// Default column sizes for categories table
const DEFAULT_CATEGORY_COLUMN_SIZES: Record<string, number> = {
  name: 350,
  partners: 120,
  transactions: 120,
};

function CategoryDataTableInner(
  { data, onRowClick, selectedRowId }: CategoryDataTableProps,
  ref: React.ForwardedRef<CategoryDataTableHandle>
) {
  const columns = React.useMemo(() => getCategoryColumns(), []);

  // Get data attributes for row
  const getRowDataAttributes = React.useCallback(
    (row: UserNoReceiptCategory) => {
      return { "category-id": row.id };
    },
    []
  );

  return (
    <ResizableDataTable
      ref={ref as React.Ref<DataTableHandle>}
      columns={columns}
      data={data}
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      defaultColumnSizes={DEFAULT_CATEGORY_COLUMN_SIZES}
      getRowDataAttributes={getRowDataAttributes}
      emptyMessage="No categories found."
    />
  );
}

export const CategoryDataTable = forwardRef(CategoryDataTableInner);
