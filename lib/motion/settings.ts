/**
 * How list rows move: arriving, changing, turning green (complete) or back,
 * and leaving. LIST_MOTION is what production runs; it is tuned in the
 * motion lab (/design-system/motion-lab), whose JSON maps onto this shape
 * one to one. lib/motion/list-motion.ts plays it on the real table.
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

export interface MotionSettings {
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

/**
 * Production values, from the motion lab JSON of 2026-10-07 (second round):
 * rows arrive in 250ms, 40ms apart, 8px up; a row turns green (or back)
 * through an ordered dither in 320ms; the rest glide 250ms when rows come or
 * go.
 */
export const LIST_MOTION: MotionSettings = {
  enter: {
    duration: 250,
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
    easing: [0.34, 1.56, 0.64, 1],
    pillDuration: 250,
    checkDuration: 300,
    completeStyle: "dither",
    completeDuration: 320,
    completeEasing: [0.65, 0, 0.28, 1],
    completeIntensity: 0.1,
    undoMirrored: false,
  },
  leave: {
    duration: 250,
    easing: [0.4, 0, 0.2, 1],
    offsetX: 16,
    collapse: true,
  },
};

export const bezierCss = (b: Bezier) => `cubic-bezier(${b.map((n) => +n.toFixed(3)).join(", ")})`;

