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
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { ResizableDataTableProps, DataTableHandle, DataTableSection, RowClickModifiers } from "./types";
import { ResizeHandle } from "./resize-handle";
import {
  columnWidthsToStore,
  parseColumnWidths,
  readStoredColumnWidths,
  sizedColumnWidth,
  writeStoredColumnWidths,
  type ColumnWidthLimits,
} from "@/lib/tables/column-widths";
import { VirtualRow } from "./virtual-row";

const DEFAULT_MIN_COLUMN_WIDTH = 60;
const DEFAULT_ESTIMATE_ROW_SIZE = 64;
const DEFAULT_SECTION_HEADER_HEIGHT = 48;
const DEFAULT_OVERSCAN = 10;
const HEADER_HEIGHT = 56; // h-14 = 3.5rem = 56px
const SCROLL_RENDER_DELAY = 150;
/** A long description must not fit its column wider than a screen */
const MAX_AUTOFIT_WIDTH = 640;

// Only this table writes its key, and it keeps the widths it sets in state, so
// there is nothing to subscribe to (as in DetailPanelLayout).
const subscribeNever = () => () => {};
const noStoredWidths = () => null;
const getLocalStorage = () => window.localStorage;

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
    columnWidthsStorageKey,
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
  // Remembered widths are read during render, so a table opens at them instead
  // of painting the defaults first; the server snapshot keeps a server render
  // and hydration at the defaults. Until the user resizes, the stored widths
  // are the sizing; from the first resize the table's own state takes over.
  const savedWidths = React.useSyncExternalStore(
    subscribeNever,
    () => (columnWidthsStorageKey ? readStoredColumnWidths(getLocalStorage, columnWidthsStorageKey) : null),
    noStoredWidths
  );
  const storedSizing = React.useMemo(() => parseColumnWidths(savedWidths), [savedWidths]);
  const [resizedSizing, setResizedSizing] = React.useState<ColumnSizingState | null>(null);
  const columnSizing = resizedSizing ?? storedSizing;
  const setColumnSizing = React.useCallback(
    (updater: React.SetStateAction<ColumnSizingState>) => {
      setResizedSizing((prev) => {
        const current = prev ?? storedSizing;
        return typeof updater === "function" ? updater(current) : updater;
      });
    },
    [storedSizing]
  );

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
    onColumnSizingChange: setColumnSizing,
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

  // Stable identity, current closure: the effect fires when the order changes,
  // not when the page re-creates its inline arrow prop, and it still calls the
  // page's newest callback.
  const emitDisplayedOrder = useLatestCallback((orderedIds: string[]) => {
    onDisplayedOrderChange?.(orderedIds);
  });

  React.useEffect(() => {
    emitDisplayedOrder(displayedRowIds);
  }, [displayedRowIds, emitDisplayedOrder]);

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

  // Each column's min/max: its own, else the table's defaults (columnDef is
  // already merged with defaultColumn). getAllColumns() is memoised by the
  // table and only changes identity when the columns do.
  const allColumns = table.getAllColumns();
  const columnLimits = React.useMemo(() => {
    const limits: Record<string, ColumnWidthLimits> = {};
    allColumns.forEach((col) => {
      limits[col.id] = {
        min: col.columnDef.minSize ?? minColumnWidth,
        max: col.columnDef.maxSize ?? Number.MAX_SAFE_INTEGER,
      };
    });
    return limits;
  }, [allColumns, minColumnWidth]);

  // Get column sizes from table state, using defaults. A sized width is held
  // inside its column's limits, so a remembered width from an older column
  // definition cannot render out of range.
  const columnSizes = React.useMemo(() => {
    return table.getAllColumns().map((col) => {
      const defaultSize = defaultColumnSizes[col.id] || 150;
      return sizedColumnWidth(columnSizing, col.id, columnLimits[col.id]) ?? defaultSize;
    });
  }, [table, columnSizing, columnLimits, defaultColumnSizes]);

  // Remember the widths once a resize is over (drag release or auto-fit),
  // never on each drag tick. The changed column's final width is passed in,
  // because the render that carries it may not have committed yet.
  const rememberColumnWidth = useLatestCallback((columnId: string, width: number) => {
    if (!columnWidthsStorageKey) return;
    // Read again rather than reuse the first render's copy: the other view of
    // this table may have stored a column since
    const previous = parseColumnWidths(readStoredColumnWidths(getLocalStorage, columnWidthsStorageKey));
    writeStoredColumnWidths(
      getLocalStorage,
      columnWidthsStorageKey,
      columnWidthsToStore({ ...columnSizing, [columnId]: width }, columnLimits, previous)
    );
  });

  // Calculate total table width
  const totalTableWidth = columnSizes.reduce((sum, w) => sum + w, 0);

  // Columns keep their recommended widths whatever the container does. The
  // table never stretches or squeezes them to fit: when the container is wider
  // than the columns, an unlabelled filler column takes the rest, and when it
  // is narrower, the table scrolls sideways.
  //
  // Double-clicking a column edge fits the column to its content, as in
  // spreadsheets and file managers: as wide as its widest cell, header
  // included, but never narrower than the column's default: the default is
  // the recommended width, and a column that happens to show only "—" on
  // screen should not collapse to nothing. Only rendered rows can be measured, so on a virtualised list
  // "widest" means widest among the rows on screen and the overscan.
  const fitColumnToContent = React.useCallback(
    (columnId: string) => {
      const root = parentRef.current;
      if (!root) return;
      const cells = root.querySelectorAll<HTMLElement>(
        `[data-col-id="${CSS.escape(columnId)}"]`
      );
      if (cells.length === 0) return;

      // Each cell is cloned into a probe that lays it out at its natural
      // width. Cells truncate inside the table, so their rendered width
      // says nothing about how wide their content wants to be.
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;width:max-content;";
      root.appendChild(probe);
      let widest = 0;
      cells.forEach((cell) => {
        const clone = cell.cloneNode(true) as HTMLElement;
        clone.style.width = "auto";
        clone.style.display = "block";
        clone.style.whiteSpace = "nowrap";
        probe.appendChild(clone);
        widest = Math.max(widest, clone.getBoundingClientRect().width);
        probe.removeChild(clone);
      });
      probe.remove();

      const width = Math.min(
        MAX_AUTOFIT_WIDTH,
        Math.max(defaultColumnSizes[columnId] || 150, Math.ceil(widest))
      );
      setColumnSizing((prev) => ({ ...prev, [columnId]: width }));
      rememberColumnWidth(columnId, width);
    },
    [defaultColumnSizes, setColumnSizing, rememberColumnWidth]
  );

  // Row click handler with multi-select support.
  //
  // Every row holds this handler across renders: VirtualRow is memoised and its
  // comparator ignores onClick on purpose (see virtual-row.tsx), so a row whose
  // own flags didn't change keeps the one it last painted with. useLatestCallback
  // is what makes that safe — the identity the row holds never changes, and the
  // call runs this render's closure, so the shift-click anchor, display order,
  // index map and selection below are read as of the click and not as of the
  // row's last render (#232, #298). It covers the consumer's onRowClick and
  // onSelectionChange too, which are read from the same live closure.
  const handleRowClick = useLatestCallback(
    (row: TData, modifiers: RowClickModifiers) => {
      if (!enableMultiSelect) {
        // Single-select mode: just call onRowClick
        onRowClick?.(row);
        return;
      }

      // Multi-select mode
      const clickedIndex = rowIdToIndexMap.get(row.id) ?? -1;
      const isModifierClick = modifiers.metaKey || modifiers.ctrlKey;
      const currentSelection = selectedRowIds ?? new Set<string>();

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

        onSelectionChange?.(newSelection, {
          isPlainClick: false,
          isRangeClick: true,
          clickedRowId: row.id,
        });
        // Don't update lastSelectedRowId on shift-click to allow extending selection
      } else if (isModifierClick) {
        // CMD/Ctrl+click: toggle individual selection
        const newSelection = new Set(currentSelection);
        if (newSelection.has(row.id)) {
          newSelection.delete(row.id);
        } else {
          newSelection.add(row.id);
        }

        onSelectionChange?.(newSelection, {
          isPlainClick: false,
          isRangeClick: false,
          clickedRowId: row.id,
        });
        setLastSelectedRowId(row.id);
      } else {
        // Regular click: clear ALL selection and select only this row
        const newSelection = new Set([row.id]);
        onSelectionChange?.(newSelection, {
          isPlainClick: true,
          isRangeClick: false,
          clickedRowId: row.id,
        });
        setLastSelectedRowId(row.id);
      }
    }
  );

  return (
    <div ref={parentRef} className="flex-1 overflow-auto relative">
      {/* Sorting indicator */}
      {isSorting && (
        <div className="absolute top-2 right-4 z-20">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {/* Separate, not collapsed, borders: a collapsed border belongs to the
          table grid rather than the cell, so on the sticky header it would
          scroll away while the cell stays put */}
      <table
        className="border-separate border-spacing-0"
        style={{ width: "100%", minWidth: totalTableWidth, tableLayout: "fixed" }}
      >
        <colgroup>
          {table.getAllColumns().map((col, i) => (
            <col key={col.id} style={{ width: columnSizes[i] }} />
          ))}
          {/* Filler: absorbs whatever width the columns leave over */}
          <col />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-muted">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="relative">
              {headerGroup.headers.map((header, index) => (
                <th
                  key={header.id}
                  data-col-id={header.column.id}
                  className={cn(
                    "h-10 px-2 text-left text-sm font-medium text-muted-foreground relative border-r border-b border-border",
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
                  {/* Custom resize handle; double-click fits the column to its content */}
                  {header.column.getCanResize() && (
                    <ResizeHandle
                      header={header as Header<unknown, unknown>}
                      onAutoFit={() => fitColumnToContent(header.column.id)}
                      onResizeEnd={(width) => rememberColumnWidth(header.column.id, width)}
                      currentSize={columnSizes[index]}
                      isLastColumn={index === headerGroup.headers.length - 1}
                      minColumnWidth={minColumnWidth}
                    />
                  )}
                </th>
              ))}
              <th aria-hidden="true" className="border-b border-border" />
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
                    <td colSpan={columns.length + 1} className="py-3 px-4">
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
              <td colSpan={columns.length + 1}>
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
