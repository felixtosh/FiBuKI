"use client";

import * as React from "react";
import { memo } from "react";
import { flexRender } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { VirtualRowProps } from "./types";

function VirtualRowInner<TData extends { id: string }>({
  row,
  isSelected,
  isPrimarySelected,
  onClick,
  virtualStart,
  virtualSize,
  columnSizes,
  className,
  dataAttributes = {},
  rowStateKey,
}: VirtualRowProps<TData>) {
  const handleClick = React.useCallback(
    (e: React.MouseEvent) => {
      onClick(row.original, {
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
      });
    },
    [onClick, row.original]
  );

  const totalWidth = columnSizes.reduce((sum, w) => sum + w, 0);

  return (
    <tr
      data-row-id={row.original.id}
      data-state={isSelected ? "selected" : undefined}
      {...Object.fromEntries(
        Object.entries(dataAttributes).map(([k, v]) => [`data-${k}`, v])
      )}
      onClick={handleClick}
      className={cn(
        "cursor-pointer transition-colors duration-300 border-b hover:bg-muted/50",
        // Primary selection: stronger highlight
        isPrimarySelected && "bg-primary/10 hover:bg-primary/15",
        // Additional selection (not primary): lighter highlight
        isSelected && !isPrimarySelected && "bg-primary/5 hover:bg-primary/10",
        className
      )}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: totalWidth,
        height: virtualSize,
        transform: `translateY(${virtualStart}px)`,
        display: "table",
        tableLayout: "fixed",
      }}
    >
      {row.getVisibleCells().map((cell, index) => (
        <td
          key={cell.id}
          className={cn(
            "px-2 py-2.5 overflow-hidden",
            index === 0 && "pl-4",
            index === row.getVisibleCells().length - 1 && "pr-4"
          )}
          style={{ width: columnSizes[index] }}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
}

// Custom memo comparison for performance
// Checks updatedAt (if present) to detect data changes while keeping memo lightweight
export const VirtualRow = memo(
  VirtualRowInner,
  (prevProps, nextProps) => {
    // Check if TanStack Row object changed (happens when columns or data change)
    // This ensures cells re-render when column closures update (e.g., partner maps populate)
    if (prevProps.row !== nextProps.row) {
      return false;
    }

    // Check if row-specific state changed (e.g., searching state for this row)
    if (prevProps.rowStateKey !== nextProps.rowStateKey) {
      return false; // Row state changed, re-render
    }

    // Check if updatedAt changed (if field exists) - lightweight way to detect data changes
    const prevUpdatedAt = (prevProps.row.original as Record<string, unknown>).updatedAt;
    const nextUpdatedAt = (nextProps.row.original as Record<string, unknown>).updatedAt;
    if (prevUpdatedAt !== nextUpdatedAt) {
      return false; // Data changed, re-render
    }

    return (
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.isPrimarySelected === nextProps.isPrimarySelected &&
      prevProps.virtualStart === nextProps.virtualStart &&
      prevProps.virtualSize === nextProps.virtualSize &&
      prevProps.className === nextProps.className &&
      prevProps.columnSizes.every(
        (size, i) => size === nextProps.columnSizes[i]
      )
    );
  }
) as <TData extends { id: string }>(
  props: VirtualRowProps<TData>
) => React.ReactElement;
