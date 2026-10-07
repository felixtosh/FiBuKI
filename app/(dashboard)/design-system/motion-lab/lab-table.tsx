"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Building2 } from "lucide-react";
import { AmountMatchDisplay } from "@/components/ui/amount-match-display";
import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/utils";
import { CompleteOverlay, hideOverlay, playComplete } from "./complete-styles";
import { bezierCss, type LabSettings } from "./settings";

export interface LabRow {
  id: string;
  date: string;
  text: string;
  amount: number;
  partner?: string;
  /** A connected File's amount; set once a File is connected. */
  fileAmount?: number;
  /** Position in the batch that is arriving; undefined = no enter animation. */
  enterIndex?: number;
  /** Bumped whenever the row's data changes, to play the change animation. */
  version: number;
  leaving?: boolean;
}

const FLASH_CLASS: Record<LabSettings["change"]["flash"], string> = {
  complete: "bg-complete-row-selected",
  info: "bg-info",
  highlight: "bg-highlight",
  none: "",
};

const euro = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" });

/** Columns of the lab table, the same widths for header and rows. */
const COLS = "grid grid-cols-[6rem_11rem_minmax(0,1fr)_7rem_6rem] items-center gap-3 px-4";

interface Timing {
  settings: LabSettings;
  /** 1 = real speed, 4 = four times slower. */
  slow: number;
}

export function LabTable({
  rows,
  settings,
  slow,
  onLeft,
}: {
  rows: LabRow[];
  settings: LabSettings;
  slow: number;
  onLeft: (id: string) => void;
}) {
  return (
    <div className="rounded-md border bg-background overflow-hidden">
      <div className={cn(COLS, "h-10 border-b bg-muted/50 text-xs font-medium text-muted-foreground")}>
        <span>Date</span>
        <span>Partner</span>
        <span>Description</span>
        <span className="text-right">Amount</span>
        <span>File</span>
      </div>
      {rows.map((row) => (
        <Row key={row.id} row={row} timing={{ settings, slow }} onLeft={onLeft} />
      ))}
    </div>
  );
}

function Row({ row, timing, onLeft }: { row: LabRow; timing: Timing; onLeft: (id: string) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const cellsRef = useRef<HTMLDivElement>(null);
  const completeRef = useRef<HTMLDivElement>(null);
  const firstVersion = useRef(row.version);
  const complete = Boolean(row.partner && row.fileAmount !== undefined);
  // The row's own colour follows `complete` only once the completion
  // animation has covered it.
  const [shownComplete, setShownComplete] = useState(complete);
  const targetComplete = useRef(complete);
  const lastFlashComplete = useRef(complete);
  const running = useRef<Animation[]>([]);
  // Animations read the settings of the moment they start; changing a slider
  // must not replay them.
  const timingRef = useRef(timing);
  useLayoutEffect(() => {
    timingRef.current = timing;
  });

  // Enter: once, when the row mounts as part of an arriving batch.
  useLayoutEffect(() => {
    if (row.enterIndex === undefined) return;
    const { settings, slow } = timingRef.current;
    const e = settings.enter;
    const delay = row.enterIndex * e.rowStagger * slow;
    const easing = bezierCss(e.easing);
    const from = {
      opacity: e.fromOpacity,
      transform: `translateY(${e.offsetY}px) scale(${e.fromScale})`,
    };
    const to = { opacity: 1, transform: "translateY(0) scale(1)" };
    const cells = Array.from(cellsRef.current?.children ?? []) as HTMLElement[];
    if (e.cellStagger > 0) {
      cells.forEach((cell, i) =>
        cell.animate([from, to], {
          duration: e.duration * slow,
          delay: delay + i * e.cellStagger * slow,
          easing,
          fill: "backwards",
        })
      );
    } else {
      rowRef.current?.animate([from, to], { duration: e.duration * slow, delay, easing, fill: "backwards" });
    }
    if (e.lineDraw) {
      lineRef.current?.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
        duration: e.lineDuration * slow,
        delay,
        easing,
        fill: "backwards",
      });
    }
  }, [row.enterIndex]);

  // Change: the whole row flashes; each changed cell animates on its own (Cell).
  useEffect(() => {
    if (row.version === firstVersion.current) return;
    const { settings, slow } = timingRef.current;
    // Turning green or back has its own animation (below), not the flash.
    const completionChanged = complete !== lastFlashComplete.current;
    lastFlashComplete.current = complete;
    if (completionChanged || settings.change.flash === "none") return;
    flashRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: settings.change.flashDuration * slow,
      easing: bezierCss(settings.change.easing),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per data change; `complete` is read, not watched
  }, [row.version]);

  // Completion: paint the new colour over the row in the chosen style, then
  // switch the row itself.
  useEffect(() => {
    const root = completeRef.current;
    if (!root || complete === targetComplete.current) return;
    targetComplete.current = complete;
    hideOverlay(root, running.current);
    const { settings, slow } = timingRef.current;
    const c = settings.change;
    const animations = playComplete(root, c.completeStyle, {
      duration: c.completeDuration * slow,
      easing: bezierCss(c.completeEasing),
      mirrored: !complete && c.undoMirrored,
      color: complete ? "var(--color-complete-row)" : "var(--color-background)",
    });
    running.current = animations;
    let cancelled = false;
    Promise.all(animations.map((a) => a.finished))
      .then(() => {
        if (cancelled) return;
        setShownComplete(complete);
        requestAnimationFrame(() => hideOverlay(root, animations));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [complete]);

  // Leave: slide and fade out, then close the gap, then drop the row.
  useEffect(() => {
    const el = rowRef.current;
    if (!row.leaving || !el) return;
    const { settings, slow } = timingRef.current;
    const l = settings.leave;
    const easing = bezierCss(l.easing);
    const out = el.animate(
      [
        { opacity: 1, transform: "translateX(0)" },
        { opacity: 0, transform: `translateX(${l.offsetX}px)` },
      ],
      { duration: l.duration * slow, easing, fill: "forwards" }
    );
    let cancelled = false;
    out.finished
      .then(() => {
        if (cancelled) return;
        if (!l.collapse) return onLeft(row.id);
        return el
          .animate([{ height: `${el.offsetHeight}px` }, { height: "0px" }], {
            duration: l.duration * slow,
            easing,
            fill: "forwards",
          })
          .finished.then(() => !cancelled && onLeft(row.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [row.leaving, row.id, onLeft]);

  return (
    <div ref={rowRef} className={cn("relative overflow-hidden", shownComplete && "bg-complete-row")}>
      <CompleteOverlay ref={completeRef} />
      <div
        ref={flashRef}
        className={cn("pointer-events-none absolute inset-0 opacity-0", FLASH_CLASS[timing.settings.change.flash])}
      />
      <div ref={cellsRef} className={cn(COLS, "relative h-12 text-sm")}>
        <div className="tabular-nums text-muted-foreground">{row.date}</div>
        <Cell value={row.partner ?? ""} timing={timing} pill>
          {row.partner ? <Pill label={row.partner} icon={Building2} matchedBy="auto" /> : <span className="text-muted-foreground">-</span>}
        </Cell>
        <div className="truncate">{row.text}</div>
        <div className={cn("text-right tabular-nums", row.amount < 0 ? "text-amount-negative" : "text-amount-positive")}>
          {euro.format(row.amount / 100)}
        </div>
        <Cell value={String(row.fileAmount ?? "")} timing={timing}>
          {row.fileAmount !== undefined ? (
            <AmountMatchDisplay
              count={1}
              countType="file"
              primaryAmount={row.amount}
              primaryCurrency="EUR"
              secondaryAmounts={[{ amount: row.fileAmount, currency: "EUR" }]}
            />
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </Cell>
      </div>
      <div ref={lineRef} className="absolute inset-x-0 bottom-0 h-px origin-left bg-border" />
    </div>
  );
}

/** A cell whose content animates in whenever its value changes after mount. */
function Cell({ value, timing, pill = false, children }: { value: string; timing: Timing; pill?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(value);
  const timingRef = useRef(timing);
  useLayoutEffect(() => {
    timingRef.current = timing;
  });

  useLayoutEffect(() => {
    if (value === first.current) return;
    const { settings, slow } = timingRef.current;
    const c = settings.change;
    const fromTransform = pill && value ? `scale(${c.pillFromScale})` : `translateY(${c.cellOffsetY}px)`;
    ref.current?.animate(
      [
        { opacity: 0, transform: fromTransform },
        { opacity: 1, transform: "none" },
      ],
      { duration: c.cellDuration * slow, easing: bezierCss(c.easing) }
    );
  }, [value, pill]);

  return (
    <div className="min-w-0">
      <div ref={ref} className="inline-flex origin-left">
        {children}
      </div>
    </div>
  );
}
