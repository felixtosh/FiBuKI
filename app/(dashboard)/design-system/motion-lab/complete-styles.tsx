"use client";

import { forwardRef } from "react";
import type { CompleteStyle } from "./settings";

/*
 * The row turning green (or back): the new colour is painted on an overlay in
 * one of several styles, and only once it covers the row does the row itself
 * switch colour. Mirroring the overlay (scaleX(-1)) runs any style right to
 * left, which is how "back to white" can run the other way.
 */

const SLICES = 12;

/** The overlay parts every style draws with; each style shows only the ones it needs. */
export const CompleteOverlay = forwardRef<HTMLDivElement>(function CompleteOverlay(_, ref) {
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden" style={{ display: "none" }}>
      <div data-part="fill" className="absolute inset-0" style={{ background: "var(--target)" }} />
      <div data-part="wave" className="absolute inset-y-0 left-0 flex w-[calc(100%+2.5rem)]">
        <div className="h-full flex-1" style={{ background: "var(--target)" }} />
        <svg data-part="wave-edge" viewBox="0 0 40 48" preserveAspectRatio="none" className="h-[140%] -mt-[10%] w-10 shrink-0" aria-hidden="true">
          <path d="M0 0 H18 C34 6 2 18 18 24 C34 30 2 42 18 48 H0 Z" style={{ fill: "var(--target)" }} />
          <path d="M18 0 C34 6 2 18 18 24 C34 30 2 42 18 48" fill="none" stroke="white" strokeOpacity="0.7" strokeWidth="2" />
        </svg>
      </div>
      <div data-part="slices" className="absolute inset-0 flex">
        {Array.from({ length: SLICES }, (_, i) => (
          <div key={i} className="h-full flex-1 origin-left" style={{ background: "var(--target)" }} />
        ))}
      </div>
      <div
        data-part="sheen"
        className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
    </div>
  );
});

interface PlayOptions {
  duration: number;
  easing: string;
  mirrored: boolean;
  /** A CSS colour, e.g. var(--color-complete-row). */
  color: string;
}

/** Plays a style on the overlay; resolves with its animations once they all finish. */
export function playComplete(root: HTMLElement, style: CompleteStyle, o: PlayOptions): Animation[] {
  const part = (name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const parts = ["fill", "wave", "slices", "sheen"];
  const show = (...names: string[]) =>
    parts.forEach((name) => (part(name).style.display = names.includes(name) ? "" : "none"));

  root.style.setProperty("--target", o.color);
  root.style.transform = o.mirrored ? "scaleX(-1)" : "";
  root.style.display = "block";
  const timing: KeyframeAnimationOptions = { duration: o.duration, easing: o.easing, fill: "forwards" };

  switch (style) {
    case "fade":
      show("fill");
      return [part("fill").animate([{ opacity: 0 }, { opacity: 1 }], timing)];

    case "wipe":
      show("fill");
      return [part("fill").animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }], timing)];

    case "splash":
      show("fill");
      return [
        part("fill").animate(
          [{ clipPath: "circle(0% at 0% 50%)" }, { clipPath: "circle(150% at 0% 50%)" }],
          timing
        ),
      ];

    case "wave": {
      show("wave");
      // The edge bobs up and down while the water rolls across.
      part("wave-edge").animate([{ transform: "translateY(-12%)" }, { transform: "translateY(12%)" }], {
        duration: o.duration / 3,
        iterations: 3,
        direction: "alternate",
        easing: "ease-in-out",
      });
      return [part("wave").animate([{ transform: "translateX(-100%)" }, { transform: "translateX(0)" }], timing)];
    }

    case "glitch": {
      show("fill");
      const step = "steps(1, end)";
      return [
        part("fill").animate(
          [
            { opacity: 0, clipPath: "inset(0 100% 0 0)", transform: "translateX(0)", filter: "none", easing: step },
            { opacity: 1, clipPath: "inset(10% 60% 55% 0)", transform: "translateX(-6px)", filter: "hue-rotate(90deg)", easing: step, offset: 0.1 },
            { opacity: 1, clipPath: "inset(50% 20% 20% 0)", transform: "translateX(5px)", filter: "none", easing: step, offset: 0.22 },
            { opacity: 0.4, clipPath: "inset(0 45% 70% 0)", transform: "translateX(-3px)", filter: "saturate(3)", easing: step, offset: 0.34 },
            { opacity: 1, clipPath: "inset(30% 0 35% 0)", transform: "translateX(7px)", filter: "hue-rotate(-60deg)", easing: step, offset: 0.48 },
            { opacity: 1, clipPath: "inset(0 0 60% 0)", transform: "translateX(-2px)", filter: "none", easing: step, offset: 0.62 },
            { opacity: 1, clipPath: "inset(40% 0 0 8%)", transform: "translateX(3px)", filter: "invert(0.15)", easing: step, offset: 0.76 },
            { opacity: 1, clipPath: "inset(0 0 0 0)", transform: "translateX(-1px)", filter: "none", easing: step, offset: 0.9 },
            { opacity: 1, clipPath: "inset(0 0 0 0)", transform: "translateX(0)", filter: "none" },
          ],
          { duration: o.duration, fill: "forwards" }
        ),
      ];
    }

    case "blinds": {
      show("slices");
      const slices = Array.from(part("slices").children) as HTMLElement[];
      const each = o.duration * 0.45;
      const gap = (o.duration - each) / (slices.length - 1);
      return slices.map((slice, i) =>
        slice.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1.02)" }], {
          duration: each,
          delay: i * gap,
          easing: o.easing,
          fill: "forwards",
        })
      );
    }

    case "shimmer":
      show("fill", "sheen");
      return [
        part("fill").animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, duration: o.duration * 0.4 }),
        part("sheen").animate([{ transform: "translateX(-100%)" }, { transform: "translateX(400%)" }], {
          duration: o.duration * 0.7,
          delay: o.duration * 0.3,
          easing: o.easing,
          fill: "forwards",
        }),
      ];
  }
}

export function hideOverlay(root: HTMLElement, animations: Animation[]) {
  animations.forEach((animation) => animation.cancel());
  root.style.display = "none";
}
