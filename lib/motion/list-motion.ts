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
  /**
   * Which rows arrive: "first-load" (production) animates only the list's
   * first appearance; rows that come in later just appear. "new-rows" (the
   * lab) animates every row new to the data.
   */
  arrivals?: "first-load" | "new-rows";
}

const MAX_STAGGERED = 20;

/**
 * No motion when the user asks for less, or where the Web Animations API is
 * missing (jsdom in the component tests; every real browser has it).
 */
function prefersReducedMotion() {
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return true;
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
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

export function createListMotion(rowAttribute = "data-row-id") {
  let previous: Map<string, MotionRow> | null = null;
  let positions = new Map<string, number>();

  return {
    update(root: HTMLElement | null, rows: MotionRow[], s: MotionSettings, options: UpdateOptions = {}) {
      const before = previous;
      // An empty first render (still loading) does not count as the first load.
      previous = rows.length || before ? new Map(rows.map((row) => [row.id, row])) : null;
      if (!root || !rows.length) return;
      const k = options.slow ?? 1;
      const reduced = prefersReducedMotion();
      // Only ever the rows the table has drawn: a long list never costs a
      // lookup per data row.
      const drawn = () => Array.from(root.querySelectorAll<HTMLElement>(`tr[${rowAttribute}]`));
      const idOf = (el: HTMLElement) => el.getAttribute(rowAttribute)!;
      const one = (id: string) => root.querySelector<HTMLElement>(`tr[${rowAttribute}="${CSS.escape(id)}"]`);
      const yOf = (el: HTMLElement) => Number(el.style.transform.match(/translateY\((-?[\d.]+)px\)/)?.[1]);
      // Where each drawn row is, for the next glide.
      const snapshot = () => {
        const at = new Map<string, number>();
        for (const el of drawn()) {
          const y = yOf(el);
          if (!Number.isNaN(y)) at.set(idOf(el), y);
        }
        positions = at;
      };

      // Arrivals, in the order they are on screen.
      const fresh = new Set<string>();
      if (!before) rows.forEach((row) => fresh.add(row.id));
      else if (options.arrivals === "new-rows") rows.forEach((row) => !before.has(row.id) && fresh.add(row.id));
      const entering = new Set<string>();
      let staggerIndex = 0;
      const arrive = () => {
        const found = drawn()
          .filter((el) => fresh.has(idOf(el)) && !entering.has(idOf(el)))
          .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        for (const el of found) {
          entering.add(idOf(el));
          if (!reduced) animateArrival(el, s, Math.min(staggerIndex, MAX_STAGGERED), k);
          staggerIndex++;
        }
      };
      if (fresh.size) {
        arrive();
        // A virtualised table draws its rows a render after it gets them (it
        // measures itself first), so look again over the next few frames,
        // still before they paint. Later rows (scrolled into view) never move.
        let tries = 0;
        const retry = () => {
          if (tries++ >= 4) return;
          arrive();
          // The rows drawn late need their place recorded too.
          snapshot();
          requestAnimationFrame(retry);
        };
        requestAnimationFrame(retry);
      }

      // Changes: compared in memory, the page touched only for changed rows.
      for (const row of rows) {
        const old = before?.get(row.id);
        if (!old) continue;
        const flipped = old.complete !== row.complete;
        const changed = old.version !== row.version;
        const leaving = row.leaving && !old.leaving;
        if (!flipped && !changed && !leaving) continue;
        const el = one(row.id);
        if (!el) {
          if (leaving) options.onLeft?.(row.id);
          continue;
        }
        const c = s.change;

        // Turning green, or back.
        if (flipped && !reduced) {
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
        } else if (changed && !flipped && c.flash !== "none" && !reduced) {
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
        if (leaving) {
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

      // Glide: drawn rows that moved because rows came or went slide to their
      // new place instead of jumping (FLIP, from the table's own translateY).
      // A sort or a column resize moves rows too, but then no row came or went.
      const cameOrWent = !!before && (before.size !== rows.length || rows.some((row) => !before.has(row.id)));
      const last = positions;
      for (const el of drawn()) {
        const id = idOf(el);
        const y = yOf(el);
        if (Number.isNaN(y)) continue;
        const was = last.get(id);
        if (!cameOrWent || reduced || was === undefined || was === y || entering.has(id) || !s.leave.collapse) continue;
        const t = y > was ? s.enter : s.leave;
        el.animate([{ translate: `0 ${was - y}px` }, { translate: "0 0" }], {
          duration: t.duration * k,
          easing: bezierCss(t.easing),
        });
      }
      snapshot();
    },
  };
}

export type ListMotion = ReturnType<typeof createListMotion>;
