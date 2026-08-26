"use client";

import * as React from "react";
import { forwardRef, useImperativeHandle } from "react";
import {
  ColumnFiltersState,
  SortingState,
  ColumnSizingState,
  Header,
  Row,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResizableDataTableProps, DataTableHandle, DataTableSection, RowClickModifiers } from "./types";
import { ResizeHandle } from "./resize-handle";
import { VirtualRow } from "./virtual-row";

const DEFAULT_MIN_COLUMN_WIDTH = 60;
const DEFAULT_ESTIMATE_ROW_SIZE = 64;
const DEFAULT_SECTION_HEADER_HEIGHT = 48;
const DEFAULT_OVERSCAN = 10;
const HEADER_HEIGHT = 56; // h-14 = 3.5rem = 56px
const SCROLL_RENDER_DELAY = 150;

/**
 * Data table item - either a section header or a data row
 */
type DataTableItem<TData> =
  | { type: "header"; sectionId: string; title: React.ReactNode; className?: string }
  | { type: "row"; data: TData; sectionId: string; rowClassName?: string };

function ResizableDataTableInner<TData extends { id: string }>(
  {
    columns,
    data,
    sections,
    onRowClick,
    selectedRowId,
    defaultColumnSizes,
    minColumnWidth = DEFAULT_MIN_COLUMN_WIDTH,
    getRowClassName,
    getRowDataAttributes,
    getRowStateKey,
    estimateRowSize = DEFAULT_ESTIMATE_ROW_SIZE,
    sectionHeaderHeight = DEFAULT_SECTION_HEADER_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    emptyMessage = "No data found.",
    emptyState,
    autoScrollToSelected = true,
    initialSorting = [],
    onSortingChange,
    enableMultiSelect = false,
    selectedRowIds,
    onSelectionChange,
    onDisplayedOrderChange,
  }: ResizableDataTableProps<TData>,
  ref: React.ForwardedRef<DataTableHandle>
) {
  // Build table items list from sections or flat data
  const { tableItems, flatData, itemToRowIndex } = React.useMemo(() => {
    const items: DataTableItem<TData>[] = [];
    const allData: TData[] = [];
    const indexMap = new Map<number, number>(); // virtualIndex -> rowIndex

    if (sections && sections.length > 0) {
      let rowIndex = 0;
      sections.forEach((section) => {
        // Only add header if section has data
        if (section.data.length > 0) {
          items.push({
            type: "header",
            sectionId: section.id,
            title: section.title,
            className: section.headerClassName,
          });
          section.data.forEach((item) => {
            const virtualIndex = items.length;
            indexMap.set(virtualIndex, rowIndex);
            items.push({
              type: "row",
              data: item,
              sectionId: section.id,
              rowClassName: section.rowClassName,
            });
            allData.push(item);
            rowIndex++;
          });
        }
      });
    } else if (data) {
      data.forEach((item, index) => {
        indexMap.set(index, index);
        items.push({ type: "row", data: item, sectionId: "default" });
        allData.push(item);
      });
    }

    return { tableItems: items, flatData: allData, itemToRowIndex: indexMap };
  }, [sections, data]);
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting);
  const [isSorting, setIsSorting] = React.useState(false);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>({});
  // Track which columns have been manually resized by user
  const [userResizedColumns, setUserResizedColumns] = React.useState<
    Set<string>
  >(new Set());
  // Container width for proportional scaling
  const [containerWidth, setContainerWidth] = React.useState<number | null>(
    null
  );
  // Flag to track if we're auto-scaling (to avoid marking as user-resized)
  const isAutoScalingRef = React.useRef(false);

  const table = useReactTable({
    data: flatData,
    columns,
    defaultColumn: {
      minSize: minColumnWidth,
      size: 150,
    },
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: (updater) => {
      setIsSorting(true);
      const newSorting = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);
      onSortingChange?.(newSorting, true);
      // Reset sorting indicator after a short delay (data is already sorted synchronously)
      requestAnimationFrame(() => {
        setIsSorting(false);
        onSortingChange?.(newSorting, false);
      });
    },
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnSizingChange: (updater) => {
      const newSizing =
        typeof updater === "function" ? updater(columnSizing) : updater;
      setColumnSizing(newSizing);
      // Only mark as user-resized if not auto-scaling
      if (!isAutoScalingRef.current) {
        const changedColumns = Object.keys(newSizing).filter(
          (colId) => newSizing[colId] !== columnSizing[colId]
        );
        if (changedColumns.length > 0) {
          setUserResizedColumns((prev) => {
            const next = new Set(prev);
            changedColumns.forEach((col) => next.add(col));
            return next;
          });
        }
      }
    },
    columnResizeMode: "onChange",
    state: {
      sorting,
      columnFilters,
      columnSizing,
    },
  });

  const parentRef = React.useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;

  // Create a map from data id to row for quick lookup
  const rowByIdMap = React.useMemo(() => {
    const map = new Map<string, Row<TData>>();
    rows.forEach((row) => {
      map.set(row.original.id, row);
    });
    return map;
  }, [rows]);

  // Build display items from sorted rows (for flat data) or sections
  // This ensures the virtualizer shows items in sorted order
  const displayItems = React.useMemo(() => {
    const items: DataTableItem<TData>[] = [];

    if (sections && sections.length > 0) {
      // For sectioned data, keep original section order but sort data within each
      sections.forEach((section) => {
        const sectionDataInSortedOrder = rows
          .filter((r) => section.data.some((d) => d.id === r.original.id))
          .map((r) => r.original);

        if (sectionDataInSortedOrder.length > 0) {
          items.push({
            type: "header",
            sectionId: section.id,
            title: section.title,
            className: section.headerClassName,
          });
          sectionDataInSortedOrder.forEach((item) => {
            items.push({
              type: "row",
              data: item,
              sectionId: section.id,
              rowClassName: section.rowClassName,
            });
          });
        }
      });
    } else {
      // For flat data, use sorted rows directly
      rows.forEach((row) => {
        items.push({ type: "row", data: row.original, sectionId: "default" });
      });
    }

    return items;
  }, [rows, sections]);

  // Report the displayed order so pages can drive prev/next from the list the
  // user sees instead of from their own array order. Derived from displayItems,
  // so it already carries the active sort (and skips section headers).
  const displayedRowIds = React.useMemo(() => {
    const ids: string[] = [];
    displayItems.forEach((item) => {
      if (item.type === "row") ids.push(item.data.id);
    });
    return ids;
  }, [displayItems]);

  // Hold the latest callback in a ref so an inline arrow prop from the page
  // doesn't re-fire the effect on every render.
  const onDisplayedOrderChangeRef = React.useRef(onDisplayedOrderChange);
  React.useEffect(() => {
    onDisplayedOrderChangeRef.current = onDisplayedOrderChange;
  }, [onDisplayedOrderChange]);

  React.useEffect(() => {
    onDisplayedOrderChangeRef.current?.(displayedRowIds);
  }, [displayedRowIds]);

  // Multi-select: track last selected ROW ID for Shift+click range selection
  // We store the ID (not index) so it stays valid when sorting changes
  const [lastSelectedRowId, setLastSelectedRowId] = React.useState<string | null>(null);

  // Multi-select: build a map from row id to display index for efficient lookups
  const rowIdToIndexMap = React.useMemo(() => {
    const map = new Map<string, number>();
    displayItems.forEach((item, index) => {
      if (item.type === "row") {
        map.set(item.data.id, index);
      }
    });
    return map;
  }, [displayItems]);

  // Get current index of last selected row (recalculated when displayItems changes)
  const lastSelectedIndex = lastSelectedRowId ? (rowIdToIndexMap.get(lastSelectedRowId) ?? null) : null;

  // Use a ref to always have the latest selectedRowIds (avoids stale closure in rapid clicks)
  const selectedRowIdsRef = React.useRef(selectedRowIds);
  React.useEffect(() => {
    selectedRowIdsRef.current = selectedRowIds;
  }, [selectedRowIds]);

  // Track total size and visible rows in state to avoid flushSync warning during render
  const [totalSize, setTotalSize] = React.useState(0);
  const [visibleRows, setVisibleRows] = React.useState<
    { index: number; start: number; size: number; key: React.Key }[]
  >([]);

  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const item = displayItems[index];
      return item?.type === "header" ? sectionHeaderHeight : estimateRowSize;
    },
    overscan,
    // Update state when virtualizer changes (scroll, resize, etc.)
    onChange: (instance) => {
      setTotalSize(instance.getTotalSize());
      setVisibleRows(instance.getVirtualItems());
    },
  });

  // Initialize on mount and when display items change (e.g., after sorting)
  // Use requestAnimationFrame to defer state updates and avoid flushSync warning
  React.useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setTotalSize(virtualizer.getTotalSize());
      setVisibleRows(virtualizer.getVirtualItems());
    });
    return () => cancelAnimationFrame(frameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayItems.length, displayItems]);

  // Expose scrollToIndex method via ref
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) => {
        virtualizer.scrollToIndex(index, { align: "center" });
      },
    }),
    [virtualizer]
  );

  // Check if element is fully visible in viewport (below header, above bottom)
  const isElementInView = React.useCallback((element: Element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= HEADER_HEIGHT && rect.bottom <= window.innerHeight - 20;
  }, []);

  // Track which selectedRowId we've successfully scrolled to
  // This allows retry when data wasn't available on first attempt (e.g., page load with ?id=XYZ)
  const scrolledToIdRef = React.useRef<string | null>(null);
  const scrollAttemptRef = React.useRef<number>(0);

  // Auto-scroll to selected row when selection changes or data becomes available
  React.useEffect(() => {
    if (!autoScrollToSelected || !selectedRowId) {
      scrolledToIdRef.current = null;
      return;
    }

    // Skip if we've already successfully scrolled to this item
    if (scrolledToIdRef.current === selectedRowId) {
      return;
    }

    // Skip scroll if element exists and is already fully visible (e.g., user clicked on it)
    const element = document.querySelector(`[data-row-id="${selectedRowId}"]`);
    if (element && isElementInView(element)) {
      scrolledToIdRef.current = selectedRowId;
      return;
    }

    // Find index in displayItems
    const index = displayItems.findIndex(
      (item) => item.type === "row" && item.data.id === selectedRowId
    );
    // If item not found yet (data still loading), don't mark as scrolled - retry when data arrives
    if (index === -1) {
      console.log("[AutoScroll] Item not in displayItems yet, waiting...", { selectedRowId, displayItemsLength: displayItems.length });
      return;
    }

    // Wait for scroll container to be ready (critical on initial page load)
    if (!parentRef.current) {
      console.log("[AutoScroll] parentRef not ready, waiting...");
      return;
    }

    console.log("[AutoScroll] Attempting scroll to index", { index, selectedRowId, totalItems: displayItems.length });

    // Track this scroll attempt to cancel if selection changes
    const attemptId = ++scrollAttemptRef.current;
    const targetId = selectedRowId;

    // Use requestAnimationFrame to ensure DOM is ready after data load
    requestAnimationFrame(() => {
      // Cancel if selection changed or already scrolled
      if (scrollAttemptRef.current !== attemptId) return;
      if (!parentRef.current) return;

      console.log("[AutoScroll] RAF fired, calling scrollToIndex", { index });

      // First scroll via virtualizer to ensure row is rendered
      virtualizer.scrollToIndex(index, { align: "center" });

      // Fine-tune with scrollIntoView after virtualized table renders
      setTimeout(() => {
        // Cancel if selection changed
        if (scrollAttemptRef.current !== attemptId) return;

        const el = document.querySelector(`[data-row-id="${targetId}"]`);
        console.log("[AutoScroll] setTimeout fired, element found:", !!el);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          // Only mark as scrolled after successful scroll
          scrolledToIdRef.current = targetId;
        }
      }, SCROLL_RENDER_DELAY);
    });
  }, [selectedRowId, autoScrollToSelected, displayItems, virtualizer, isElementInView]);

  // Get column sizes from table state, using defaults
  const columnSizes = React.useMemo(() => {
    return table.getAllColumns().map((col) => {
      const defaultSize = defaultColumnSizes[col.id] || 150;
      return columnSizing[col.id] ?? defaultSize;
    });
  }, [table, columnSizing, defaultColumnSizes]);

  // Calculate total table width
  const totalTableWidth = columnSizes.reduce((sum, w) => sum + w, 0);

  // Observe container width changes (debounced - only after resize ends)
  React.useEffect(() => {
    if (!parentRef.current) return;

    let resizeTimeout: NodeJS.Timeout | null = null;

    const observer = new ResizeObserver((entries) => {
      // Debounce - wait for resize to settle
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const entry = entries[0];
        if (entry) {
          setContainerWidth(entry.contentRect.width);
        }
      }, 150); // Wait 150ms after last resize event
    });

    observer.observe(parentRef.current);
    // Set initial width
    setContainerWidth(parentRef.current.clientWidth);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      observer.disconnect();
    };
  }, []);

  // Track previous container width to detect actual container resizes
  const prevContainerWidthRef = React.useRef<number | null>(null);

  // Auto-scale columns proportionally when container size changes (not on column resize)
  React.useEffect(() => {
    if (containerWidth === null) return;

    // Skip if this is not a container resize (first render or same width)
    const isFirstRender = prevContainerWidthRef.current === null;
    const containerSizeChanged = prevContainerWidthRef.current !== containerWidth;
    prevContainerWidthRef.current = containerWidth;

    // Only auto-scale on actual container resize, not on initial render with existing sizes
    if (!containerSizeChanged && !isFirstRender) return;

    const allColumns = table.getAllColumns();

    // Calculate default total width
    const defaultTotalWidth = allColumns.reduce((sum, col) => {
      return sum + (defaultColumnSizes[col.id] || 150);
    }, 0);

    // Only scale if container is larger than default total
    if (containerWidth <= defaultTotalWidth) return;

    // Calculate scale factor
    const scaleFactor = containerWidth / defaultTotalWidth;

    // Build new column sizes - scale all columns proportionally
    const newSizing: ColumnSizingState = {};
    allColumns.forEach((col) => {
      const defaultSize = defaultColumnSizes[col.id] || 150;
      newSizing[col.id] = Math.round(defaultSize * scaleFactor);
    });

    // Set flag to prevent marking these as user-resized
    isAutoScalingRef.current = true;
    setColumnSizing(newSizing);
    // Also clear user-resized set on container resize
    setUserResizedColumns(new Set());
    // Reset flag after state update
    requestAnimationFrame(() => {
      isAutoScalingRef.current = false;
    });
  }, [containerWidth, table, defaultColumnSizes]);

  // Get column size helper
  const getColumnSize = React.useCallback(
    (colId: string) => {
      return columnSizing[colId] ?? (defaultColumnSizes[colId] || 150);
    },
    [columnSizing, defaultColumnSizes]
  );

  // Get last column ID
  const lastColumnId = React.useMemo(() => {
    const allColumns = table.getAllColumns();
    return allColumns[allColumns.length - 1]?.id || "";
  }, [table]);

  // Reset column to default size (and adjust last column to compensate)
  const resetColumnToDefault = React.useCallback(
    (columnId: string) => {
      const defaultSize = defaultColumnSizes[columnId] || 150;
      const currentSize = columnSizing[columnId] ?? defaultSize;
      const delta = currentSize - defaultSize;

      if (columnId === lastColumnId) {
        // If resetting last column, just set to default
        setColumnSizing((prev) => ({
          ...prev,
          [columnId]: defaultSize,
        }));
      } else {
        // Adjust last column to compensate
        const lastColCurrentSize =
          columnSizing[lastColumnId] ?? (defaultColumnSizes[lastColumnId] || 150);
        setColumnSizing((prev) => ({
          ...prev,
          [columnId]: defaultSize,
          [lastColumnId]: lastColCurrentSize + delta,
        }));
      }
      // Remove from user-resized set
      setUserResizedColumns((prev) => {
        const next = new Set(prev);
        next.delete(columnId);
        return next;
      });
    },
    [columnSizing, lastColumnId, defaultColumnSizes]
  );

  // Row click handler with multi-select support
  const handleRowClick = React.useCallback(
    (row: TData, modifiers: RowClickModifiers) => {
      if (!enableMultiSelect) {
        // Single-select mode: just call onRowClick
        onRowClick?.(row);
        return;
      }

      // Multi-select mode
      // Use ref to get latest selection (avoids stale closure when clicking rapidly)
      const clickedIndex = rowIdToIndexMap.get(row.id) ?? -1;
      const isModifierClick = modifiers.metaKey || modifiers.ctrlKey;
      const currentSelection = selectedRowIdsRef.current ?? new Set<string>();

      if (modifiers.shiftKey && lastSelectedIndex !== null && clickedIndex !== -1) {
        // Shift+click: select range from lastSelectedIndex to clicked index
        // Clear previous selections and select only the range
        const start = Math.min(lastSelectedIndex, clickedIndex);
        const end = Math.max(lastSelectedIndex, clickedIndex);

        const newSelection = new Set<string>();
        for (let i = start; i <= end; i++) {
          const item = displayItems[i];
          if (item?.type === "row") {
            newSelection.add(item.data.id);
          }
        }

        onSelectionChange?.(newSelection);
        // Don't update lastSelectedRowId on shift-click to allow extending selection
      } else if (isModifierClick) {
        // CMD/Ctrl+click: toggle individual selection
        const newSelection = new Set(currentSelection);
        if (newSelection.has(row.id)) {
          newSelection.delete(row.id);
        } else {
          newSelection.add(row.id);
        }

        onSelectionChange?.(newSelection);
        setLastSelectedRowId(row.id);
      } else {
        // Regular click: clear ALL selection and select only this row
        const newSelection = new Set([row.id]);
        onSelectionChange?.(newSelection);
        setLastSelectedRowId(row.id);
      }
    },
    [enableMultiSelect, onRowClick, lastSelectedIndex, displayItems, rowIdToIndexMap, onSelectionChange]
  );

  return (
    <div ref={parentRef} className="flex-1 overflow-auto relative">
      {/* Sorting indicator */}
      {isSorting && (
        <div className="absolute top-2 right-4 z-20">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      <table
        className="border-collapse"
        style={{ width: totalTableWidth, tableLayout: "fixed" }}
      >
        <colgroup>
          {table.getAllColumns().map((col, i) => (
            <col key={col.id} style={{ width: columnSizes[i] }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-muted">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b relative">
              {headerGroup.headers.map((header, index) => (
                <th
                  key={header.id}
                  className={cn(
                    "h-10 px-2 text-left text-sm font-medium text-muted-foreground relative",
                    index === 0 && "pl-4",
                    index === headerGroup.headers.length - 1 && "pr-4"
                  )}
                  style={{ width: columnSizes[index] }}
                >
                  <div className="flex items-center min-w-0 overflow-hidden w-full">
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </div>
                  {/* Custom resize handle with double-click reset (skip last column) */}
                  {header.column.getCanResize() && index !== headerGroup.headers.length - 1 && (
                    <ResizeHandle
                      header={header as Header<unknown, unknown>}
                      onResetToDefault={() => resetColumnToDefault(header.column.id)}
                      lastColumnId={lastColumnId}
                      getColumnSize={getColumnSize}
                      minColumnWidth={minColumnWidth}
                    />
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody className="relative" style={{ height: totalSize }}>
          {displayItems.length ? (
            visibleRows.map((visibleRow) => {
              const item = displayItems[visibleRow.index];

              // Guard against undefined item (can happen during rapid data changes)
              if (!item) return null;

              // Render section header
              if (item.type === "header") {
                return (
                  <tr
                    key={`header-${item.sectionId}`}
                    className={cn("hover:bg-transparent", item.className)}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: visibleRow.size,
                      transform: `translateY(${visibleRow.start}px)`,
                    }}
                  >
                    <td
                      colSpan={columns.length}
                      className="py-3 px-4"
                      style={{ width: totalTableWidth }}
                    >
                      {item.title}
                    </td>
                  </tr>
                );
              }

              // Render data row
              const row = rowByIdMap.get(item.data.id);
              if (!row) return null;

              const original = row.original;
              const isPrimarySelected = selectedRowId === original.id;
              const isSelected = enableMultiSelect
                ? (selectedRowIds?.has(original.id) ?? false)
                : isPrimarySelected;
              const baseClassName = getRowClassName?.(original, isSelected);
              const sectionClassName = item.rowClassName;
              const combinedClassName = cn(baseClassName, sectionClassName);
              const dataAttributes = getRowDataAttributes?.(original);

              return (
                <VirtualRow
                  key={row.id}
                  row={row}
                  isSelected={isSelected}
                  isPrimarySelected={isPrimarySelected}
                  onClick={handleRowClick}
                  virtualStart={visibleRow.start}
                  virtualSize={visibleRow.size}
                  columnSizes={columnSizes}
                  className={combinedClassName}
                  dataAttributes={dataAttributes}
                  rowStateKey={getRowStateKey?.(original)}
                />
              );
            })
          ) : (
            <tr>
              <td colSpan={columns.length}>
                {emptyState || (
                  <div className="h-24 flex items-center justify-center text-muted-foreground">
                    {emptyMessage}
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Export with forwardRef - using type assertion for generic component with ref
export const ResizableDataTable = forwardRef(ResizableDataTableInner) as <
  TData extends { id: string }
>(
  props: ResizableDataTableProps<TData> & { ref?: React.Ref<DataTableHandle> }
) => React.ReactElement;
