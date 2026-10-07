/**
 * What the motion lab lets you tune, and the JSON it hands back. The JSON is
 * the hand-off: copy it, paste it to Claude, and it becomes the real tokens
 * and classes.
 */

import type { CanvasStyle } from "./canvas-fx";

export type Bezier = [number, number, number, number];

/** How a row turns green when it completes, and back when it no longer is. */
export type CompleteStyle =
  | CanvasStyle
  | "fade"
  | "wipe"
  | "splash"
  | "wave"
  | "glitch"
  | "blinds"
  | "shimmer";

/** Canvas effects first (drawn frame by frame), then the plain CSS ones. */
export const COMPLETE_STYLES: { value: CompleteStyle; label: string; canvas?: boolean }[] = [
  { value: "liquid", label: "Liquid: water front with foam", canvas: true },
  { value: "pixel-glitch", label: "Pixel glitch: tearing, fringes", canvas: true },
  { value: "ink", label: "Ink: soaks in with a wet rim", canvas: true },
  { value: "ripple", label: "Ripple: shock ring, cells bob", canvas: true },
  { value: "particles", label: "Particles: a swarm lands in place", canvas: true },
  { value: "dither", label: "Dither: ordered pixel reveal", canvas: true },
  { value: "fade", label: "Fade" },
  { value: "wipe", label: "Wipe, left to right" },
  { value: "splash", label: "Splash from the left" },
  { value: "wave", label: "Ocean wave" },
  { value: "glitch", label: "Glitch" },
  { value: "blinds", label: "Blinds" },
  { value: "shimmer", label: "Fade, then shimmer" },
];

export interface LabSettings {
  /** Rows arriving: a list loading, or new rows coming in. */
  enter: {
    duration: number;
    easing: Bezier;
    /** Delay between one row and the next. */
    rowStagger: number;
    /** Delay between the cells of one row (0 = the row moves as one piece). */
    cellStagger: number;
    /** How far a row travels up while it appears. */
    offsetY: number;
    fromOpacity: number;
    fromScale: number;
    /** The divider line under a row draws in from the left. */
    lineDraw: boolean;
    lineDuration: number;
  };
  /** A row whose data changes: a Partner is assigned, a File connected, the row completes. */
  change: {
    flash: "complete" | "info" | "highlight" | "none";
    flashDuration: number;
    /** Curve of the flash, the pill pop and the check. */
    easing: Bezier;
    /** The real animate-pill-pop: a Partner or category assigned on screen. */
    pillDuration: number;
    /** The real animate-check-appear: the check in the File pill. */
    checkDuration: number;
    /** The row turning green (complete) or back. */
    completeStyle: CompleteStyle;
    completeDuration: number;
    completeEasing: Bezier;
    /** How much a canvas effect does: wave height, glitch amount, particle spread. */
    completeIntensity: number;
    /** Going back from green runs the other way, right to left. */
    undoMirrored: boolean;
  };
  /** A row leaving the list (a filter no longer matches it). */
  leave: {
    duration: number;
    easing: Bezier;
    offsetX: number;
    /** The rows below close the gap. */
    collapse: boolean;
  };
}

export const EASING_PRESETS: { name: string; token?: string; value: Bezier }[] = [
  { name: "slide", token: "--ease-slide", value: [0.4, 0, 0.2, 1] },
  { name: "out-expo", token: "--ease-out-expo", value: [0.16, 1, 0.3, 1] },
  { name: "out-back", token: "--ease-out-back", value: [0.34, 1.56, 0.64, 1] },
  { name: "spring", token: "--ease-spring", value: [0.175, 0.885, 0.32, 1.275] },
  { name: "ease-out", value: [0, 0, 0.2, 1] },
  { name: "in-out", value: [0.65, 0, 0.35, 1] },
  { name: "linear", value: [0, 0, 1, 1] },
];

/** Today's curves of the two real cell animations (globals.css). */
export const PILL_EASING: Bezier = [0.34, 1.56, 0.64, 1];

export const DEFAULT_SETTINGS: LabSettings = {
  enter: {
    duration: 320,
    easing: [0.16, 1, 0.3, 1],
    rowStagger: 40,
    cellStagger: 0,
    offsetY: 8,
    fromOpacity: 0,
    fromScale: 1,
    lineDraw: false,
    lineDuration: 400,
  },
  change: {
    flash: "none",
    flashDuration: 900,
    easing: PILL_EASING,
    pillDuration: 250,
    checkDuration: 300,
    completeStyle: "liquid",
    completeDuration: 900,
    completeEasing: [0.65, 0, 0.35, 1],
    completeIntensity: 0.7,
    undoMirrored: true,
  },
  leave: {
    duration: 250,
    easing: [0.4, 0, 0.2, 1],
    offsetX: 16,
    collapse: true,
  },
};

export const bezierCss = (b: Bezier) => `cubic-bezier(${b.map((n) => +n.toFixed(3)).join(", ")})`;

function parseBezier(value: unknown, fallback: Bezier): Bezier {
  const nums = String(value).match(/-?\d*\.?\d+/g)?.map(Number);
  return nums && nums.length === 4 ? (nums as Bezier) : fallback;
}

/** The JSON to copy: easings written as CSS, so it reads like the theme does. */
export function toJson(s: LabSettings): string {
  return JSON.stringify(
    {
      fibukiMotionLab: 1,
      enter: { ...s.enter, easing: bezierCss(s.enter.easing) },
      change: { ...s.change, easing: bezierCss(s.change.easing), completeEasing: bezierCss(s.change.completeEasing) },
      leave: { ...s.leave, easing: bezierCss(s.leave.easing) },
    },
    null,
    2
  );
}

/** Reads pasted JSON back, keeping the defaults for anything missing. */
export function fromJson(text: string): LabSettings {
  const raw = JSON.parse(text);
  const d = DEFAULT_SETTINGS;
  return {
    enter: { ...d.enter, ...raw.enter, easing: parseBezier(raw.enter?.easing, d.enter.easing) },
    change: {
      ...d.change,
      ...raw.change,
      easing: parseBezier(raw.change?.easing, d.change.easing),
      completeEasing: parseBezier(raw.change?.completeEasing, d.change.completeEasing),
    },
    leave: { ...d.leave, ...raw.leave, easing: parseBezier(raw.leave?.easing, d.leave.easing) },
  };
}
