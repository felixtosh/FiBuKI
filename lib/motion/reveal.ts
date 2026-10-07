import type { CompleteStyle } from "./settings";

/*
 * The real Transactions row changes colour the moment its data does. To make
 * that change deliberate, a layer in the OLD colour is laid over the row in
 * the same frame and then cleared away in one of these styles, so the new
 * colour shows through left to right. Mirroring the layer (scaleX(-1)) runs
 * any style right to left. All of it is plain DOM on the real <tr>, which is
 * also how it would be wired into the real table.
 */

const SLICES = 12;
const EDGE = 40; // px, the wave's curl

/** A layer inside a real row: absolutely positioned, under the cells (see the stage's CSS). */
export function rowLayer(tr: HTMLElement, name: string): HTMLElement {
  let layer = tr.querySelector<HTMLElement>(`:scope > [data-lab-layer="${name}"]`);
  if (!layer) {
    layer = document.createElement("div");
    layer.dataset.labLayer = name;
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0;display:none";
    tr.appendChild(layer);
  }
  return layer;
}

let radiusRegistered = false;
function registerRadius() {
  if (radiusRegistered) return;
  radiusRegistered = true;
  try {
    CSS.registerProperty({ name: "--lab-r", syntax: "<length>", inherits: false, initialValue: "0px" });
  } catch {
    // Already registered (hot reload) or unsupported: the splash then jumps.
  }
}

interface RevealOptions {
  duration: number;
  easing: string;
  mirrored: boolean;
  /** The colour the row HAD, e.g. var(--color-background). */
  oldColor: string;
}

/** Covers the row in its old colour and clears it away; returns the animations. */
export function playReveal(tr: HTMLElement, style: CompleteStyle, o: RevealOptions): Animation[] {
  const layer = rowLayer(tr, "reveal");
  layer.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  layer.innerHTML = "";
  layer.style.display = "block";
  layer.style.transform = o.mirrored ? "scaleX(-1)" : "";
  layer.style.setProperty("--old", o.oldColor);
  const timing: KeyframeAnimationOptions = { duration: o.duration, easing: o.easing, fill: "forwards" };
  const add = (css: string) => {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;${css}`;
    layer.appendChild(el);
    return el;
  };

  switch (style) {
    case "fade":
      return [add("inset:0;background:var(--old)").animate([{ opacity: 1 }, { opacity: 0 }], timing)];

    case "wipe":
      return [
        add("inset:0;background:var(--old)").animate(
          [{ clipPath: "inset(0 0 0 0%)" }, { clipPath: "inset(0 0 0 100%)" }],
          timing
        ),
      ];

    case "splash": {
      registerRadius();
      const fill = add("inset:0;background:var(--old)");
      const mask = "radial-gradient(circle at 0% 50%, transparent var(--lab-r), black calc(var(--lab-r) + 1px))";
      fill.style.setProperty("mask-image", mask);
      fill.style.setProperty("-webkit-mask-image", mask);
      const reach = Math.hypot(tr.offsetWidth, tr.offsetHeight);
      return [fill.animate([{ "--lab-r": "0px" }, { "--lab-r": `${reach}px` }] as Keyframe[], timing)];
    }

    case "wave": {
      // [curl][old colour], starting with the curl just off the left edge and
      // rolling right until the old colour has left the row.
      const wave = add(`top:0;bottom:0;left:-${EDGE}px;width:calc(100% + ${EDGE}px);display:flex`);
      wave.innerHTML = `
        <svg viewBox="0 0 40 48" preserveAspectRatio="none" style="width:${EDGE}px;height:140%;margin-top:-10%;flex-shrink:0" aria-hidden="true">
          <path d="M40 0 H22 C6 6 38 18 22 24 C6 30 38 42 22 48 H40 Z" style="fill:var(--old)" />
          <path d="M22 0 C6 6 38 18 22 24 C6 30 38 42 22 48" fill="none" stroke="white" stroke-opacity="0.8" stroke-width="2" />
        </svg>
        <div style="flex:1;background:var(--old)"></div>`;
      wave.firstElementChild!.animate([{ transform: "translateY(-12%)" }, { transform: "translateY(12%)" }], {
        duration: o.duration / 3,
        iterations: 3,
        direction: "alternate",
        easing: "ease-in-out",
      });
      return [wave.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], timing)];
    }

    case "glitch": {
      const step = "steps(1, end)";
      return [
        add("inset:0;background:var(--old)").animate(
          [
            { opacity: 1, clipPath: "inset(0 0 0 0)", transform: "translateX(0)", filter: "none", easing: step },
            { opacity: 1, clipPath: "inset(0 0 45% 30%)", transform: "translateX(-6px)", filter: "hue-rotate(90deg)", easing: step, offset: 0.12 },
            { opacity: 0.7, clipPath: "inset(40% 0 0 0)", transform: "translateX(5px)", filter: "none", easing: step, offset: 0.24 },
            { opacity: 1, clipPath: "inset(0 25% 60% 0)", transform: "translateX(-3px)", filter: "saturate(3)", easing: step, offset: 0.38 },
            { opacity: 1, clipPath: "inset(55% 0 10% 40%)", transform: "translateX(7px)", filter: "hue-rotate(-60deg)", easing: step, offset: 0.52 },
            { opacity: 0.5, clipPath: "inset(0 0 70% 60%)", transform: "translateX(-2px)", filter: "none", easing: step, offset: 0.66 },
            { opacity: 1, clipPath: "inset(80% 10% 0 70%)", transform: "translateX(3px)", filter: "invert(0.15)", easing: step, offset: 0.8 },
            { opacity: 0, clipPath: "inset(0 0 0 100%)", transform: "translateX(0)", filter: "none" },
          ],
          { duration: o.duration, fill: "forwards" }
        ),
      ];
    }

    case "blinds": {
      const slices = add("inset:0;display:flex");
      const each = o.duration * 0.45;
      const gap = (o.duration - each) / (SLICES - 1);
      return Array.from({ length: SLICES }, (_, i) => {
        const slice = document.createElement("div");
        slice.style.cssText = "flex:1;height:100%;background:var(--old);transform-origin:right";
        slices.appendChild(slice);
        return slice.animate([{ transform: "scaleX(1.02)" }, { transform: "scaleX(0)" }], {
          duration: each,
          delay: i * gap,
          easing: o.easing,
          fill: "forwards",
        });
      });
    }

    case "shimmer": {
      const fill = add("inset:0;background:var(--old)");
      const sheen = add(
        "top:0;bottom:0;left:0;width:25%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent);transform:translateX(-100%)"
      );
      return [
        fill.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: o.duration * 0.4 }),
        sheen.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(400%)" }], {
          duration: o.duration * 0.7,
          delay: o.duration * 0.3,
          easing: o.easing,
          fill: "forwards",
        }),
      ];
    }

    // Canvas styles are drawn by canvas-fx.ts, not here.
    default:
      return [];
  }
}

/** Hides a layer once its animations are done. */
export function clearLayer(layer: HTMLElement) {
  layer.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  layer.innerHTML = "";
  layer.style.display = "none";
}
