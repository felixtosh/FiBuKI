import { CANVAS_STYLES, playCanvasReveal, type CanvasStyle } from "./canvas-fx";
import { clearLayer, playReveal, rowLayer } from "./reveal";
import { bezierCss, type MotionSettings } from "./settings";

/*
 * Plays MotionSettings on a real, virtualised table from outside: it finds
 * each <tr> by a data attribute and animates it with the CSS `translate` and
 * `scale` properties, which compose with the table's own `transform`
 * positioning instead of fighting it. The Transactions table and the motion
 * lab both run this, so the lab shows exactly what production does.
 *
 * Call update() after every commit (a layout effect, so nothing paints in
 * between) with the rows in data order:
 * - a row new to the data arrives, including the whole list the first time
 *   it shows (a row that only mounts because it was scrolled into view is
 *   not new, and does not move);
 * - a row whose `complete` flips turns green, or back, in the chosen style;
 * - a row whose `version` changes otherwise can flash;
 * - a row marked `leaving` slides out (the lab only: real data just goes);
 * - rows that moved because others came or went glide to their new place.
 */

export interface MotionRow {
  id: string;
  complete: boolean;
  /** Changes whenever the row's data changes; optional. */
  version?: unknown;
  /** The lab marks a row before removing it, so it can slide out. */
  leaving?: boolean;
}

export interface UpdateOptions {
  /** Slow motion: 1 = real speed. */
  slow?: number;
  /** The lab removes a row once its leave animation has played. */
  onLeft?: (id: string) => void;
}

const MAX_STAGGERED = 20;

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Lifts a row's cells above its effect layers while an effect runs, then puts them back. */
function liftCells(tr: HTMLElement): () => void {
  const cells = Array.from(tr.children).filter((el) => el.tagName === "TD") as HTMLElement[];
  for (const cell of cells) {
    cell.style.position = "relative";
    cell.style.zIndex = "1";
  }
  // The row's own colour transition would wash the reveal out.
  tr.style.transition = "none";
  return () => {
    for (const cell of cells) {
      cell.style.position = "";
      cell.style.zIndex = "";
    }
    tr.style.transition = "";
  };
}

/** One row arriving: fades and rises into place, cells one after another if set. */
function animateArrival(el: HTMLElement, s: MotionSettings, index: number, k: number) {
  const e = s.enter;
  const delay = index * e.rowStagger * k;
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
    line.style.cssText += ";display:block;inset:auto 0 0 0;height:1px;background:var(--color-border);transform-origin:left";
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

export function createListMotion(rowAttribute = "data-transaction-id") {
  let previous: Map<string, MotionRow> | null = null;
  let positions = new Map<string, number>();

  return {
    update(root: HTMLElement | null, rows: MotionRow[], s: MotionSettings, options: UpdateOptions = {}) {
      const before = previous;
      // An empty first render (still loading) does not count as seen.
      previous = rows.length || before ? new Map(rows.map((row) => [row.id, row])) : null;
      if (!root) return;
      const k = options.slow ?? 1;
      const reduced = prefersReducedMotion();
      const tr = (id: string) => root.querySelector<HTMLElement>(`tr[${rowAttribute}="${CSS.escape(id)}"]`);

      // Arrivals, in the order they are on screen. The first rows ever seen
      // arrive too: that is the list loading.
      const known = before ?? new Map<string, MotionRow>();
      const fresh = rows.filter((row) => !known.has(row.id));
      const entering = new Set<string>();
      let staggerIndex = 0;
      const arrive = (candidates: MotionRow[]) => {
        const found = candidates
          .map((row) => ({ row, el: tr(row.id) }))
          .filter((a): a is { row: MotionRow; el: HTMLElement } => a.el !== null)
          .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
        for (const { row, el } of found) {
          entering.add(row.id);
          if (!reduced) animateArrival(el, s, Math.min(staggerIndex, MAX_STAGGERED), k);
          staggerIndex++;
        }
        return candidates.filter((row) => !entering.has(row.id));
      };
      let missing = arrive(fresh);
      // A virtualised table draws its rows a render after it gets them (it
      // measures itself first), so rows that are new but not drawn yet are
      // looked for again over the next frames, still before they paint. Rows
      // that never show (scrolled out of view) simply never animate.
      let tries = 0;
      const retry = () => {
        if (!missing.length || tries++ >= 4) return;
        missing = arrive(missing);
        requestAnimationFrame(retry);
      };
      if (missing.length && fresh.length) requestAnimationFrame(retry);

      for (const row of rows) {
        const old = before?.get(row.id);
        if (!old) continue;
        const el = tr(row.id);
        if (!el) continue;
        const c = s.change;

        // Turning green, or back.
        if (old.complete !== row.complete && !reduced) {
          const layer = rowLayer(el, "reveal");
          const drop = liftCells(el);
          const green = "var(--color-complete-row)";
          const white = "var(--color-background)";
          const mirrored = !row.complete && c.undoMirrored;
          const oldColor = old.complete ? green : white;
          const done = CANVAS_STYLES.includes(c.completeStyle as CanvasStyle)
            ? playCanvasReveal(el, layer, c.completeStyle as CanvasStyle, {
                duration: c.completeDuration * k,
                easing: c.completeEasing,
                mirrored,
                oldColor,
                newColor: row.complete ? green : white,
                intensity: c.completeIntensity,
              }).finished
            : Promise.all(
                playReveal(el, c.completeStyle, {
                  duration: c.completeDuration * k,
                  easing: bezierCss(c.completeEasing),
                  mirrored,
                  oldColor,
                }).map((a) => a.finished)
              );
          done
            .catch(() => {})
            .then(() => {
              clearLayer(layer);
              drop();
            });
        } else if (old.version !== row.version && c.flash !== "none" && !reduced) {
          const flash = rowLayer(el, "flash");
          const drop = liftCells(el);
          flash.style.display = "block";
          flash.style.background = `var(--color-${c.flash === "complete" ? "complete-row-selected" : c.flash})`;
          flash
            .animate([{ opacity: 1 }, { opacity: 0 }], { duration: c.flashDuration * k, easing: bezierCss(c.easing), fill: "forwards" })
            .finished.catch(() => {})
            .then(() => {
              clearLayer(flash);
              drop();
            });
        }

        // Leaving (the lab).
        if (row.leaving && !old.leaving) {
          const l = s.leave;
          const out = reduced
            ? Promise.resolve()
            : el
                .animate(
                  [
                    { opacity: 1, translate: "0 0" },
                    { opacity: 0, translate: `${l.offsetX}px 0` },
                  ],
                  { duration: l.duration * k, easing: bezierCss(l.easing), fill: "forwards" }
                )
                .finished.then(() => {});
          out.catch(() => {}).then(() => options.onLeft?.(row.id));
        }
      }

      // Glide: rows that moved because rows came or went slide to their new
      // place instead of jumping (FLIP, read from the table's own translateY).
      const next = new Map<string, number>();
      for (const row of rows) {
        const el = tr(row.id);
        const y = Number(el?.style.transform.match(/translateY\((-?[\d.]+)px\)/)?.[1]);
        if (!el || Number.isNaN(y)) continue;
        next.set(row.id, y);
        const was = positions.get(row.id);
        if (reduced || was === undefined || was === y || entering.has(row.id) || !s.leave.collapse) continue;
        // Only rows that moved because the data changed: a sort or a column
        // resize also moves rows, but then nothing arrived or left.
        if (!before || (fresh.length === 0 && before.size === rows.length)) continue;
        const t = y > was ? s.enter : s.leave;
        el.animate([{ translate: `0 ${was - y}px` }, { translate: "0 0" }], {
          duration: t.duration * k,
          easing: bezierCss(t.easing),
        });
      }
      positions = next;
    },
  };
}

export type ListMotion = ReturnType<typeof createListMotion>;
