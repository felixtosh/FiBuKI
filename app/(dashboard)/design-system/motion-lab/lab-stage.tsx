"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { DataTable } from "@/components/transactions/data-table";
import { getTransactionColumns, type FileAmountData } from "@/components/transactions/transaction-columns";
import type { UserPartner } from "@/types/partner";
import type { TransactionSource } from "@/types/source";
import type { Transaction } from "@/types/transaction";
import { clearLayer, playReveal, rowLayer } from "./reveal";
import { bezierCss, type LabSettings } from "./settings";

/*
 * The real Transactions table (DataTable + getTransactionColumns), fed sample
 * rows. The lab never changes the table: it finds the real <tr> by its
 * data-transaction-id and animates it from outside, with the CSS `translate`
 * property so it never fights the table's own `transform` positioning.
 */

export interface LabRow {
  id: string;
  /** yyyy-mm-dd */
  date: string;
  counterparty: string;
  reference: string;
  amount: number;
  partner?: string;
  /** A connected File's amount; set once a File is connected. */
  fileAmount?: number;
  /** Position in the batch that is arriving; undefined = no enter animation. */
  enterIndex?: number;
  /** Bumped whenever the row's data changes. */
  version: number;
  leaving?: boolean;
}

const SOURCES = [{ id: "lab-source", name: "Revolut Business" }] as unknown as TransactionSource[];
// Old enough that the table's own "just completed" glow never plays: the lab's
// completion style stands in for it.
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

const partnerId = (name: string) => `lab-partner-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function toTransaction(row: LabRow): Transaction {
  return {
    id: row.id,
    // Stored like real data: UTC midnight of the calendar day, so no time shows.
    date: new Date(`${row.date}T00:00:00Z`),
    amount: row.amount,
    currency: "EUR",
    name: row.reference,
    partner: row.counterparty,
    description: row.reference,
    sourceId: "lab-source",
    partnerId: row.partner ? partnerId(row.partner) : undefined,
    partnerType: row.partner ? "user" : undefined,
    partnerMatchedBy: row.partner ? "auto" : undefined,
    partnerMatchConfidence: row.partner ? 92 : undefined,
    fileIds: row.fileAmount !== undefined ? [`lab-file-${row.id}`] : [],
    updatedAt: LONG_AGO,
  } as unknown as Transaction;
}

const isComplete = (row: LabRow) => row.fileAmount !== undefined;

export function LabStage({
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
  const rootRef = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, LabRow>());
  const positions = useRef(new Map<string, number>());
  const timingRef = useRef({ settings, slow, onLeft });
  useLayoutEffect(() => {
    timingRef.current = { settings, slow, onLeft };
  });

  const data = useMemo(() => rows.map(toTransaction), [rows]);
  const columns = useMemo(() => {
    const names = [...new Set(rows.flatMap((row) => (row.partner ? [row.partner] : [])))];
    const partners = names.map((name) => ({ id: partnerId(name), name })) as unknown as UserPartner[];
    const files = new Map<string, FileAmountData>(
      rows
        .filter((row) => row.fileAmount !== undefined)
        .map((row) => [row.id, { totalAmount: row.fileAmount!, fileCount: 1, amounts: [{ amount: row.fileAmount!, currency: "EUR" }], hasExtractingFiles: false }])
    );
    return getTransactionColumns(SOURCES, partners, [], [], undefined, files);
  }, [rows]);

  // Runs after the table has rendered the new rows and before the browser
  // paints them, so a covering layer or a starting offset never flickers.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const { settings: s, slow: k } = timingRef.current;
    const before = previous.current;
    previous.current = new Map(rows.map((row) => [row.id, row]));
    const tr = (id: string) => root.querySelector<HTMLElement>(`tr[data-transaction-id="${id}"]`);
    const entering = new Set<string>();

    for (const row of rows) {
      const el = tr(row.id);
      if (!el) continue;
      const old = before.get(row.id);

      // Arrive
      if (!old && row.enterIndex !== undefined) {
        entering.add(row.id);
        const e = s.enter;
        const delay = row.enterIndex * e.rowStagger * k;
        const easing = bezierCss(e.easing);
        const from = { opacity: e.fromOpacity, translate: `0 ${e.offsetY}px`, scale: `${e.fromScale}` };
        const to = { opacity: 1, translate: "0 0", scale: "1" };
        if (e.cellStagger > 0) {
          Array.from(el.children).forEach((cell, i) =>
            (cell as HTMLElement).animate([from, to], {
              duration: e.duration * k,
              delay: delay + i * e.cellStagger * k,
              easing,
              fill: "backwards",
            })
          );
        } else {
          el.animate([from, to], { duration: e.duration * k, delay, easing, fill: "backwards" });
        }
        if (e.lineDraw) {
          const line = rowLayer(el, "line");
          line.style.display = "block";
          line.style.inset = "auto 0 0 0";
          line.style.height = "1px";
          line.style.background = "var(--color-border)";
          line.style.transformOrigin = "left";
          line
            .animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], {
              duration: e.lineDuration * k,
              delay,
              easing,
              fill: "backwards",
            })
            .finished.then(() => clearLayer(line))
            .catch(() => {});
          el.animate([{ borderBottomColor: "transparent" }, { borderBottomColor: "transparent" }], {
            duration: e.lineDuration * k + delay,
          });
        }
      }

      // Change
      if (old && old.version !== row.version) {
        const c = s.change;
        if (isComplete(old) !== isComplete(row)) {
          const layer = rowLayer(el, "reveal");
          const animations = playReveal(el, c.completeStyle, {
            duration: c.completeDuration * k,
            easing: bezierCss(c.completeEasing),
            mirrored: !isComplete(row) && c.undoMirrored,
            oldColor: isComplete(old) ? "var(--color-complete-row)" : "var(--color-background)",
          });
          Promise.all(animations.map((a) => a.finished))
            .then(() => clearLayer(layer))
            .catch(() => {});
        } else if (c.flash !== "none") {
          const flash = rowLayer(el, "flash");
          flash.style.display = "block";
          flash.style.background = `var(--color-${c.flash === "complete" ? "complete-row-selected" : c.flash})`;
          flash
            .animate([{ opacity: 1 }, { opacity: 0 }], { duration: c.flashDuration * k, easing: bezierCss(c.easing), fill: "forwards" })
            .finished.then(() => clearLayer(flash))
            .catch(() => {});
        }
      }

      // Leave
      if (row.leaving && !old?.leaving) {
        const l = s.leave;
        el.animate(
          [
            { opacity: 1, translate: "0 0" },
            { opacity: 0, translate: `${l.offsetX}px 0` },
          ],
          { duration: l.duration * k, easing: bezierCss(l.easing), fill: "forwards" }
        )
          .finished.then(() => timingRef.current.onLeft(row.id))
          .catch(() => {});
      }
    }

    // Glide: rows that moved because rows arrived or left slide to their new
    // place instead of jumping (FLIP, from the table's own translateY).
    const next = new Map<string, number>();
    for (const row of rows) {
      const el = tr(row.id);
      const y = Number(el?.style.transform.match(/translateY\((-?[\d.]+)px\)/)?.[1]);
      if (!el || Number.isNaN(y)) continue;
      next.set(row.id, y);
      const was = positions.current.get(row.id);
      if (was === undefined || was === y || entering.has(row.id) || !s.leave.collapse) continue;
      const pushedDown = y > was;
      const t = pushedDown ? s.enter : s.leave;
      el.animate([{ translate: `0 ${was - y}px` }, { translate: "0 0" }], {
        duration: t.duration * k,
        easing: bezierCss(t.easing),
      });
    }
    positions.current = next;
  }, [rows]);

  // Overrides of the two real cell animations, so the sliders tune the
  // actual CSS the cells use (and slow motion slows it too).
  const c = settings.change;
  const css = `
    .motion-lab-stage tr[data-transaction-id] { transition: none; }
    .motion-lab-stage tr[data-transaction-id] > td { position: relative; z-index: 1; }
    .motion-lab-stage .animate-pill-pop { animation-duration: ${c.pillDuration * slow}ms; animation-timing-function: ${bezierCss(c.easing)}; }
    .motion-lab-stage .animate-check-appear { animation-duration: ${c.checkDuration * slow}ms; animation-timing-function: ${bezierCss(c.easing)}; }
  `;

  return (
    <div ref={rootRef} className="motion-lab-stage h-[560px] rounded-md border overflow-hidden">
      <style>{css}</style>
      <DataTable columns={columns} data={data} />
    </div>
  );
}
