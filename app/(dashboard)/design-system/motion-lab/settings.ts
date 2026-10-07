/**
 * The motion lab's side of the settings: the dropdown and preset lists and
 * the JSON hand-off. The settings themselves, and the values production
 * runs, live in lib/motion/settings.ts; the lab starts from those.
 */

import {
  LIST_MOTION,
  bezierCss,
  type Bezier,
  type CompleteStyle,
  type MotionSettings,
} from "@/lib/motion/settings";

export { bezierCss, type Bezier, type CompleteStyle };
export type LabSettings = MotionSettings;

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

export const EASING_PRESETS: { name: string; token?: string; value: Bezier }[] = [
  { name: "slide", token: "--ease-slide", value: [0.4, 0, 0.2, 1] },
  { name: "out-expo", token: "--ease-out-expo", value: [0.16, 1, 0.3, 1] },
  { name: "out-back", token: "--ease-out-back", value: [0.34, 1.56, 0.64, 1] },
  { name: "spring", value: [0.175, 0.885, 0.32, 1.275] },
  { name: "ease-out", value: [0, 0, 0.2, 1] },
  { name: "in-out", value: [0.65, 0, 0.35, 1] },
  { name: "linear", value: [0, 0, 1, 1] },
];

/** What production runs today: the lab starts here. */
export const DEFAULT_SETTINGS: LabSettings = LIST_MOTION;

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
