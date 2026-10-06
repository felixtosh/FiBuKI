"use client";

import * as React from "react";
import { Header } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { useLatestCallback } from "@/hooks/use-latest-callback";

// A double-tap: two taps on the same edge with the same kind of pointer, close
// in time and place, roughly the window touch platforms use
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 24;
// How far a press may wander and still be a tap rather than a drag
const TAP_SLOP = 10;

// The touch or pen pointer resizing a column right now, across every handle:
// a pointer that lands on another column's edge mid-drag starts nothing
let activePointerId: number | null = null;

interface ResizeHandleProps {
  header: Header<unknown, unknown>;
  /** Double-click or double-tap: fit the column to its content */
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
  // Where a touch or pen press began and how far it has wandered since
  const pressRef = React.useRef({ x: 0, y: 0, moved: 0 });
  // The last tap on this edge, which a second one can make a double-tap
  const lastTapRef = React.useRef<{
    pointerType: string;
    x: number;
    y: number;
    time: number;
  } | null>(null);
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
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      if (isResizing || activePointerId !== null) return;
      // Also stops the emulated mouse events and long-press text selection;
      // touch-action: none on the handle keeps the table from scrolling
      e.preventDefault();
      e.stopPropagation();
      // Cancelling pointerdown also swallows the mousedown whose click count
      // drives double-click auto-fit, so a double-tap is read here
      const lastTap = lastTapRef.current;
      lastTapRef.current = null;
      if (
        lastTap &&
        lastTap.pointerType === e.pointerType &&
        Date.now() - lastTap.time <= DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE
      ) {
        onAutoFit();
        return;
      }
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // The pointer is already gone; the document listeners still end the drag
      }
      activePointerId = e.pointerId;
      pressRef.current = { x: e.clientX, y: e.clientY, moved: 0 };
      startResize(e.clientX, e.pointerId);
    },
    [isResizing, onAutoFit, startResize]
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
    const wander = (e: PointerEvent) => {
      const press = pressRef.current;
      press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
    };
    const handlePointerMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      wander(e);
      resizeTo(e.clientX);
    };
    // A cancelled drag (e.g. the browser took over the gesture) keeps the
    // width it reached, as the column already shows it
    const handlePointerEnd = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      wander(e);
      const isTap = e.type === "pointerup" && pressRef.current.moved <= TAP_SLOP;
      lastTapRef.current = isTap
        ? { pointerType: e.pointerType, x: e.clientX, y: e.clientY, time: Date.now() }
        : null;
      activePointerId = null;
      finishResize();
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

  // Unmounted mid-drag: free the other handles for the next pointer
  React.useEffect(
    () => () => {
      if (pointerIdRef.current !== null && activePointerId === pointerIdRef.current) {
        activePointerId = null;
      }
    },
    []
  );

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
