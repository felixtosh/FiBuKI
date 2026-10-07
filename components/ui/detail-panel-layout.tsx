"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";

type MainProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };

// Only this component writes the key, and it keeps the committed width in
// state, so there is nothing to subscribe to.
const subscribeNever = () => () => {};
const noStoredWidth = () => null;

function parseStoredWidth(saved: string | null, min: number, max: number): number | null {
  if (!saved) return null;
  const parsed = parseInt(saved, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

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
}: DetailPanelLayoutProps) {
  // The stored width is read during render, so a layout that mounts with its
  // panel open (the pages mount it once their data has loaded) opens at that
  // width instead of painting the default first. The server snapshot keeps a
  // server render and hydration at the default.
  const saved = useSyncExternalStore(
    subscribeNever,
    () => localStorage.getItem(storageKey),
    noStoredWidth
  );
  const [committedWidth, setCommittedWidth] = useState<number | null>(null);
  const width = committedWidth ?? parseStoredWidth(saved, minWidth, maxWidth) ?? defaultWidth;
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const currentWidthRef = useRef(width);

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
      setCommittedWidth(currentWidthRef.current);
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
        className={cn(mainClassName, "transition-[margin] duration-200 ease-slide")}
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
              "w-1 cursor-col-resize bg-border hover:bg-primary/20 transition-colors flex-shrink-0",
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
