import { ColumnDef, Row, SortingState } from "@tanstack/react-table";
import { ReactNode } from "react";

/**
 * Section definition for grouped data tables
 */
export interface DataTableSection<TData> {
  /** Unique section identifier */
  id: string;
  /** Section header content (ReactNode for flexibility) */
  title: ReactNode;
  /** Data items in this section */
  data: TData[];
  /** Optional className for the section header row */
  headerClassName?: string;
  /** Optional className for data rows in this section */
  rowClassName?: string;
}

/** Modifier keys passed with row click events for multi-select handling */
export interface RowClickModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface ResizableDataTableProps<TData extends { id: string }> {
  columns: ColumnDef<TData, unknown>[];
  /** Flat data array (use this OR sections, not both) */
  data?: TData[];
  /** Sectioned data with headers (use this OR data, not both) */
  sections?: DataTableSection<TData>[];
  onRowClick?: (row: TData) => void;
  selectedRowId?: string | null;
  defaultColumnSizes: Record<string, number>;
  minColumnWidth?: number;
  getRowClassName?: (row: TData, isSelected: boolean) => string;
  getRowDataAttributes?: (row: TData) => Record<string, string>;
  /** Get row-specific state key - changes to this value trigger row re-render (e.g., searching state) */
  getRowStateKey?: (row: TData) => string | number | boolean | undefined;
  estimateRowSize?: number;
  /** Height for section header rows (default: 48) */
  sectionHeaderHeight?: number;
  overscan?: number;
  emptyMessage?: string;
  /** Custom empty state component (takes precedence over emptyMessage) */
  emptyState?: ReactNode;
  /** Auto-scroll to selected row when it changes (default: true). Skips scroll if row is already visible. */
  autoScrollToSelected?: boolean;
  /** Initial sorting state */
  initialSorting?: SortingState;
  /** Callback when sorting changes - receives sorting state and isSorting flag */
  onSortingChange?: (sorting: SortingState, isSorting: boolean) => void;
  /** Enable multi-select mode with CMD/Ctrl+click and Shift+click (default: false) */
  enableMultiSelect?: boolean;
  /** Set of currently selected row IDs (for multi-select mode) */
  selectedRowIds?: Set<string>;
  /** Callback when selection changes in multi-select mode */
  onSelectionChange?: (selectedIds: Set<string>) => void;
  /**
   * Callback with the row ids in the order they are displayed (the data the
   * table was given, in the active sort order). Fires whenever that order
   * changes, so pages can drive prev/next navigation from what the user sees.
   */
  onDisplayedOrderChange?: (orderedIds: string[]) => void;
}

export interface DataTableHandle {
  scrollToIndex: (index: number) => void;
}

export interface VirtualRowProps<TData extends { id: string }> {
  row: Row<TData>;
  isSelected: boolean;
  /** True if this is the primary/anchor selection (stronger highlight) */
  isPrimarySelected?: boolean;
  onClick: (row: TData, modifiers: RowClickModifiers) => void;
  virtualStart: number;
  virtualSize: number;
  columnSizes: number[];
  className?: string;
  dataAttributes?: Record<string, string>;
  /** Row-specific state that should trigger re-render when changed (e.g., searching state) */
  rowStateKey?: string | number | boolean;
}
