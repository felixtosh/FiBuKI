"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export interface OverflowFilterItem {
  key: string;
  node: React.ReactNode;
  /** The filter is set, so "More" can say how many of its hidden ones are. */
  active?: boolean;
}

const GAP = 8; // gap-2

/**
 * A toolbar row that never wraps (#522). The leading control (search) always
 * shows; the filter chips show in order for as long as they fit, and the rest
 * move behind a "More" button. The button says how many hidden filters are
 * set, so a filter never goes unseen just because the window is narrow.
 *
 * "More" opens the hidden filters as a list of full-width rows: a popover
 * anchored to the button on a wide screen, a bottom sheet on a phone, where a
 * popover would land off-screen or under a thumb. Each row is the same chip
 * the toolbar shows, so it opens its own picker exactly as it would inline.
 *
 * Fitting is measured, not guessed. Every chip renders exactly once, in the
 * row or in the panel, because several keep their popover's open state in the
 * toolbar and a second copy would open with it. Each chip's width is cached
 * whenever it sits in the row (the first paint shows them all), and the row
 * re-fits from that cache on every resize and every label change.
 */
export function OverflowFilterRow({
  leading,
  items,
  moreLabel,
  panelTitle,
  clearLabel,
  onClearAll,
  className,
}: {
  leading?: React.ReactNode;
  items: OverflowFilterItem[];
  /** "More", the button's label. */
  moreLabel: string;
  /** Heading of the panel the hidden filters open in. */
  panelTitle: string;
  clearLabel?: string;
  /** Clears every filter; offered in the panel when one is set. */
  onClearAll?: () => void;
  className?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const itemEls = useRef(new Map<string, HTMLDivElement>());
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef(96);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [open, setOpen] = useState(false);
  const isPhone = useIsPhone();
  const keys = items.map((item) => item.key).join("|");

  const fit = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    // Not laid out (hidden tab, test DOM): nothing to fit against, show all.
    if (row.clientWidth === 0) {
      setVisibleCount(keys.split("|").length);
      return;
    }
    // Refresh the cache from whatever is in the row right now.
    for (const [key, el] of itemEls.current) widths.current.set(key, el.offsetWidth);
    if (moreRef.current) moreWidth.current = moreRef.current.offsetWidth;

    const leadingWidth = leadingRef.current?.offsetWidth ?? 0;
    const available = row.clientWidth - (leadingWidth > 0 ? leadingWidth + GAP : 0);
    const itemWidths = keys.split("|").map((key) => widths.current.get(key) ?? 0);
    const total =
      itemWidths.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, itemWidths.length - 1);
    if (total <= available) {
      setVisibleCount(itemWidths.length);
      return;
    }

    let used = 0;
    let count = 0;
    for (const width of itemWidths) {
      const next = used + width + (count > 0 ? GAP : 0);
      if (next + GAP + moreWidth.current > available) break;
      used = next;
      count++;
    }
    setVisibleCount(count);
  }, [keys]);

  // ResizeObserver reports every observed element once when observing starts
  // and again on each size change, before paint: that covers the first fit,
  // a resize, and a chip whose label grew.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    if (rowRef.current) observer.observe(rowRef.current);
    if (leadingRef.current) observer.observe(leadingRef.current);
    for (const el of itemEls.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [fit, visibleCount]);

  const itemRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) itemEls.current.set(key, el);
    else itemEls.current.delete(key);
  };

  const visible = items.slice(0, visibleCount);
  const hidden = items.slice(visibleCount);
  const hiddenActive = hidden.filter((item) => item.active).length;
  const anyActive = items.some((item) => item.active);

  // Nothing left to show in the panel: closed rather than empty.
  const panelOpen = open && hidden.length > 0;

  const moreButton = (
    <Button
      ref={moreRef}
      variant={hiddenActive > 0 ? "secondary" : "outline"}
      size="sm"
      className="h-9 gap-1.5 shrink-0"
      aria-label={hiddenActive > 0 ? `${moreLabel} (${hiddenActive})` : moreLabel}
    >
      <span>{moreLabel}</span>
      {hiddenActive > 0 && (
        <span className="rounded-full bg-primary text-primary-foreground text-[10px] leading-none px-1.5 py-0.5 tabular-nums">
          {hiddenActive}
        </span>
      )}
      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", panelOpen && "rotate-180")} />
    </Button>
  );

  const panelBody = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{panelTitle}</span>
        {onClearAll && clearLabel && anyActive && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={onClearAll}>
            <X className="h-3 w-3" />
            {clearLabel}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 [&>div>button]:w-full [&>div>button]:justify-start">
        {hidden.map((item) => (
          <div key={item.key}>{item.node}</div>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={rowRef} className={cn("flex items-center gap-2 min-w-0 flex-1 overflow-hidden p-0.5 -m-0.5", className)}>
      {leading && (
        <div ref={leadingRef} className="shrink-0">
          {leading}
        </div>
      )}

      {visible.map((item) => (
        <div key={item.key} ref={itemRef(item.key)} className="shrink-0">
          {item.node}
        </div>
      ))}

      {hidden.length > 0 &&
        (isPhone ? (
          <Sheet open={panelOpen} onOpenChange={setOpen}>
            <SheetTrigger asChild>{moreButton}</SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-xl max-h-[80vh] overflow-y-auto pb-8">
              <SheetHeader className="sr-only">
                <SheetTitle>{panelTitle}</SheetTitle>
              </SheetHeader>
              {panelBody}
            </SheetContent>
          </Sheet>
        ) : (
          <Popover open={panelOpen} onOpenChange={setOpen}>
            <PopoverTrigger asChild>{moreButton}</PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-3">
              {panelBody}
            </PopoverContent>
          </Popover>
        ))}

    </div>
  );
}

function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isPhone;
}
