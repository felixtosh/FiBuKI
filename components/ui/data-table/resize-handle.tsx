"use client";

import * as React from "react";
import { Header } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { useLatestCallback } from "@/hooks/use-latest-callback";

interface ResizeHandleProps {
  header: Header<unknown, unknown>;
  /** Double-click: fit the column to its content */
  onAutoFit: () => void;
  /** A drag ended at this width; called once per drag, never per move */
  onResizeEnd?: (width: number) => void;
  /** The width the column renders at, which header.getSize() does not know */
  currentSize: number;
  /**
   * The handle straddles the column edge, reaching 8px into the next column.
   * Past the last column there is no next column, so that overhang would widen
   * the scroll area and leave a gap; there it stays inside its own column.
   */
  isLastColumn?: boolean;
  minColumnWidth: number;
}

export function ResizeHandle({
  header,
  onAutoFit,
  onResizeEnd,
  currentSize,
  isLastColumn = false,
  minColumnWidth,
}: ResizeHandleProps) {
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(0);
  const lastWidthRef = React.useRef<number | null>(null);
  // The touch or pen pointer driving the drag; null while a mouse drives it
  const pointerIdRef = React.useRef<number | null>(null);
  // Stable, so an inline callback does not re-attach the drag listeners
  const endResize = useLatestCallback((width: number) => onResizeEnd?.(width));

  const startResize = React.useCallback(
    (clientX: number, pointerId: number | null) => {
      setIsResizing(true);
      startXRef.current = clientX;
      startWidthRef.current = currentSize;
      lastWidthRef.current = null;
      pointerIdRef.current = pointerId;
    },
    [currentSize]
  );

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // A double-click is read off the second mousedown, not a dblclick
      // listener: the first mousedown puts up the full-screen resize overlay,
      // so the second click lands on that and dblclick never reaches here.
      if (e.detail >= 2) {
        onAutoFit();
        return;
      }
      startResize(e.clientX, null);
    },
    [onAutoFit, startResize]
  );

  // Touch and pen (#714). A mouse is left to its mouse events above: cancelling
  // its pointerdown would swallow the mousedown that carries the click count.
  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" || !e.isPrimary || isResizing) return;
      // Also stops the emulated mouse events and long-press text selection;
      // touch-action: none on the handle keeps the table from scrolling
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // The pointer is already gone; the document listeners still end the drag
      }
      startResize(e.clientX, e.pointerId);
    },
    [isResizing, startResize]
  );

  React.useEffect(() => {
    if (!isResizing) return;

    const resizeTo = (clientX: number) => {
      const delta = clientX - startXRef.current;
      const newSize = Math.max(minColumnWidth, startWidthRef.current + delta);
      lastWidthRef.current = newSize;
      // Only this column changes; the table grows or shrinks with it
      header.getContext().table.setColumnSizing((old) => ({
        ...old,
        [header.column.id]: newSize,
      }));
    };

    const finishResize = () => {
      setIsResizing(false);
      // A click on the edge without a move resized nothing
      if (lastWidthRef.current !== null) endResize(lastWidthRef.current);
      lastWidthRef.current = null;
      pointerIdRef.current = null;
    };

    const pointerId = pointerIdRef.current;
    if (pointerId === null) {
      const handleMouseMove = (e: MouseEvent) => resizeTo(e.clientX);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", finishResize);
      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", finishResize);
      };
    }

    // Captured pointer events target the handle and bubble up to here
    const handlePointerMove = (e: PointerEvent) => {
      if (e.pointerId === pointerId) resizeTo(e.clientX);
    };
    // A cancelled drag (e.g. the browser took over the gesture) keeps the
    // width it reached, as the column already shows it
    const handlePointerEnd = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finishResize();
    };
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerEnd);
    document.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerEnd);
      document.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [isResizing, header, minColumnWidth, endResize]);

  return (
    <>
      <div
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
        className={cn(
          "absolute right-0 top-0 h-full cursor-col-resize select-none touch-none flex items-center group",
          isLastColumn ? "w-2 justify-end" : "w-4 -mr-2 justify-center"
        )}
        style={{ touchAction: "none" }}
      >
        <div
          className={cn(
            "h-full w-0.5 transition-colors",
            "group-hover:bg-primary/50 group-active:bg-primary",
            isResizing && "bg-primary"
          )}
        />
      </div>
      {/* Overlay to prevent text selection during resize */}
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}
