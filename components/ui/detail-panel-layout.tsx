"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";

type MainProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };

interface DetailPanelLayoutProps {
  /** localStorage key the width is saved under; each page keeps its own. */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Whether the list makes room for the panel. */
  open: boolean;
  /** The panel's content; nothing is rendered while it is null or `open` is false. */
  panel: ReactNode;
  /** The list side. */
  children: ReactNode;
  /** Classes of the list side, besides the margin transition. */
  mainClassName?: string;
  /** Extra props for the list side's element (e.g. a dropzone's root props). */
  mainProps?: MainProps;
  /** `bar` draws the handle as a visible line; `subtle` shows it on hover only. */
  handleVariant?: "subtle" | "bar";
}

/**
 * A list with a resizable detail panel fixed to the right. The width is written
 * to the DOM during a drag and committed to state (and storage) on release, so
 * the list does not re-render on every mouse move.
 */
export function DetailPanelLayout({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  open,
  panel,
  children,
  mainClassName = "h-full",
  mainProps,
  handleVariant = "subtle",
}: DetailPanelLayoutProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const currentWidthRef = useRef(defaultWidth);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;
    const parsed = parseInt(saved, 10);
    if (isNaN(parsed) || parsed < minWidth || parsed > maxWidth) return;
    // Deferred so setState runs event-handler-style, not from the effect body.
    queueMicrotask(() => setWidth(parsed));
  }, [storageKey, minWidth, maxWidth]);

  const handleResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      currentWidthRef.current = width;
      setIsResizing(true);
    },
    [width]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current || !panelRef.current) return;
      const delta = dragRef.current.startX - e.clientX;
      const next = Math.min(maxWidth, Math.max(minWidth, dragRef.current.startWidth + delta));
      panelRef.current.style.width = `${next}px`;
      currentWidthRef.current = next;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setWidth(currentWidthRef.current);
      localStorage.setItem(storageKey, currentWidthRef.current.toString());
      dragRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, storageKey, minWidth, maxWidth]);

  const showPanel = open && panel != null && panel !== false;

  return (
    <>
      <div
        {...mainProps}
        data-slot="detail-panel-main"
        className={cn(mainClassName, "transition-[margin] duration-200 ease-in-out")}
        style={{ ...mainProps?.style, marginRight: open ? width : 0 }}
      >
        {children}
      </div>

      {showPanel && (
        <div
          ref={panelRef}
          data-slot="detail-panel"
          className="fixed right-0 top-14 bottom-0 z-50 bg-background border-l flex"
          style={{ width }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            className={cn(
              "w-1 cursor-col-resize flex-shrink-0",
              handleVariant === "bar"
                ? "bg-border hover:bg-primary/20 active:bg-primary/30"
                : "hover:bg-primary/20 transition-colors",
              isResizing && "bg-primary/30"
            )}
            onMouseDown={handleResizeStart}
          />
          <div className="flex-1 overflow-hidden detail-panel-container">{panel}</div>
        </div>
      )}

      {/* Keeps text from being selected while resizing */}
      {isResizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}
