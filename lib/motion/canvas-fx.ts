import type { Bezier } from "./settings";

/*
 * Canvas effects for a row changing colour. A canvas the size of the row is
 * laid UNDER the row's cells (the stage puts cells above layers), painted
 * every frame for the length of the effect, then removed: nothing runs while
 * nothing changes. The row itself already has its new colour; the canvas
 * paints what is still the OLD colour, plus whatever the effect throws on top
 * (foam, glitch blocks, rings). Some effects also touch the real cells: text
 * that splits into colour fringes, cells that bob as a wave passes.
 *
 * Coordinates are "logical": x runs in the direction of the effect. A
 * mirrored effect (back to white, right to left) flips the canvas instead of
 * the maths.
 */

export type CanvasStyle = "liquid" | "pixel-glitch" | "ink" | "dither" | "ripple" | "particles";

export const CANVAS_STYLES: CanvasStyle[] = ["liquid", "pixel-glitch", "ink", "dither", "ripple", "particles"];

export interface CanvasRevealOptions {
  duration: number;
  easing: Bezier;
  mirrored: boolean;
  /** CSS colours; var(...) is resolved against the page. */
  oldColor: string;
  newColor: string;
  /** 0..1, how much the effect does. */
  intensity: number;
}

export interface Playing {
  finished: Promise<void>;
}

type RGB = [number, number, number];

interface Ctx {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  W: number;
  H: number;
  dpr: number;
  old: RGB;
  next: RGB;
  I: number;
  /** The row's real cells, with their logical centre x. */
  cells: { el: HTMLElement; x: number }[];
  rand: () => number;
}

interface Effect {
  /** t: 0..1 time, p: eased progress, dt: seconds since last frame, ms: elapsed. */
  draw(t: number, p: number, dt: number, ms: number): void;
  cleanup?(): void;
}

// ---------------------------------------------------------------- helpers

/** CSS cubic-bezier as a function of time. */
export function bezierFn([x1, y1, x2, y2]: Bezier): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) return sy(t);
      const d = dsx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    while (hi - lo > 1e-5) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Any CSS colour (var() included) as RGB, via the canvas's own colour parser. */
function resolveRgb(el: HTMLElement, css: string): RGB {
  const probe = document.createElement("span");
  probe.style.color = css;
  el.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const c = document.createElement("canvas").getContext("2d")!;
  c.fillStyle = computed;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

const rgba = ([r, g, b]: RGB, a = 1) => `rgba(${r},${g},${b},${a})`;
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** 0 at the start and end of the effect, 1 in the middle. */
const swell = (t: number) => Math.pow(Math.sin(Math.PI * clamp01(t)), 0.6);

function resetCells(c: Ctx) {
  for (const { el } of c.cells) {
    el.style.translate = "";
    el.style.filter = "";
  }
}

// ---------------------------------------------------------------- effects

/** A water front: three travelling sines, a sloshing envelope, a glossy crest and foam. */
function liquid(c: Ctx): Effect {
  const { ctx, W, H, I, rand } = c;
  const A0 = H * (0.25 + 0.45 * I);
  const margin = A0 * 2.2 + 12;
  const lambda = H * 1.7;
  const foam: { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number }[] = [];
  let lastX = -margin;

  return {
    draw(t, p, dt, ms) {
      const env = swell(t);
      const A = A0 * env;
      const X = -margin + p * (W + 2 * margin);
      const phase = (ms / 1000) * Math.PI * 2 * 1.3;
      const lean = A * 1.1;
      const front = (y: number) =>
        X +
        A *
          (0.6 * Math.sin((2 * Math.PI * y) / lambda + phase) +
            0.28 * Math.sin((2 * Math.PI * y) / (lambda * 0.47) - phase * 1.7) +
            0.12 * Math.sin((2 * Math.PI * y) / (lambda * 0.21) + phase * 2.6)) +
        lean * (y / H - 0.5);

      ctx.clearRect(0, 0, W, H);
      const path = new Path2D();
      path.moveTo(front(-2), -2);
      for (let y = 0; y <= H + 2; y += 2) path.lineTo(front(y), y);
      const crest = new Path2D(path);
      path.lineTo(W + 10, H + 2);
      path.lineTo(W + 10, -2);
      path.closePath();

      // The old colour still to go, with water piling up against the front.
      ctx.fillStyle = rgba(c.old);
      ctx.fill(path);
      ctx.save();
      ctx.translate(5, 0);
      ctx.lineWidth = 10;
      ctx.strokeStyle = `rgba(0,0,0,${0.05 * env})`;
      ctx.stroke(crest);
      ctx.restore();

      // Gloss on the new side, then the bright crest line.
      ctx.lineJoin = "round";
      ctx.lineWidth = 16 * env;
      ctx.strokeStyle = rgba(mix(c.next, [255, 255, 255], 0.5), 0.35 * env);
      ctx.stroke(crest);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * env})`;
      ctx.stroke(crest);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(255,255,255,${0.95 * env})`;
      ctx.stroke(crest);

      // Foam thrown off the crest.
      const speed = dt > 0 ? (X - lastX) / dt : 0;
      lastX = X;
      const spawn = Math.round(I * 10 * env);
      for (let i = 0; i < spawn; i++) {
        const y = rand() * H;
        const max = 0.35 + rand() * 0.6;
        foam.push({ x: front(y) - 1, y, vx: speed * (0.25 + rand() * 0.9) + (rand() - 0.5) * 40, vy: (rand() - 0.6) * 90, life: max, max, r: 0.6 + rand() * 1.8 });
      }
      for (let i = foam.length - 1; i >= 0; i--) {
        const f = foam[i];
        f.life -= dt;
        if (f.life <= 0) {
          foam.splice(i, 1);
          continue;
        }
        f.vx *= 0.95;
        f.vy += 140 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${0.9 * (f.life / f.max)})`;
        ctx.fill();
      }

      // The real cells lift a little as the crest passes under them.
      const mid = front(H / 2);
      for (const cell of c.cells) {
        const d = cell.x - mid;
        cell.el.style.translate = `0 ${(-2.5 * I * env * Math.exp(-(d * d) / (2 * 45 * 45))).toFixed(2)}px`;
      }
    },
    cleanup: () => resetCells(c),
  };
}

/** Block pixels, a corrupted frontier, slice tearing, scanlines; the real text splits into colour fringes. */
function pixelGlitch(c: Ctx): Effect {
  const { ctx, canvas, W, H, I, rand } = c;
  const b = 5;
  const cols = Math.ceil(W / b), rows = Math.ceil(H / b);
  const noise = Float32Array.from({ length: cols * rows }, () => rand());
  const score = (i: number) => ((i % cols) / cols) * 0.72 + noise[i] * 0.28;
  const palette: RGB[] = [c.next, c.old, [255, 255, 255], [17, 17, 17], [255, 0, 128], [0, 220, 255]];
  const fringe = "drop-shadow(3px 0 rgba(255,0,90,.6)) drop-shadow(-3px 0 rgba(0,210,255,.6))";
  let lastStep = -1;

  return {
    draw(t, p, _dt, ms) {
      // Glitches stutter: a new frame only 30 times a second.
      const step = Math.floor(ms / 33);
      if (step === lastStep) return;
      lastStep = step;
      const env = swell(t);
      ctx.clearRect(0, 0, W, H);

      const rest = new Path2D();
      const band = 0.05 + 0.08 * I;
      for (let i = 0; i < cols * rows; i++) {
        const s = score(i);
        const x = (i % cols) * b, y = Math.floor(i / cols) * b;
        if (Math.abs(s - p) < band * env) {
          const colour = palette[Math.floor(rand() * palette.length)];
          ctx.fillStyle = rgba(colour, 0.45 + rand() * 0.55);
          ctx.fillRect(x, y, b, b);
        } else if (s >= p) {
          rest.rect(x, y, b, b);
        }
      }
      ctx.fillStyle = rgba(c.old);
      ctx.fill(rest);

      // Tear a few horizontal slices sideways.
      if (rand() < 0.55 * I * env) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const count = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < count; k++) {
          const sy = Math.floor(rand() * H * c.dpr);
          const sh = Math.max(2, Math.floor((2 + rand() * 10) * c.dpr));
          const dx = Math.round((rand() - 0.5) * 70 * I * c.dpr);
          ctx.drawImage(canvas, 0, sy, canvas.width, sh, dx, sy, canvas.width, sh);
        }
        ctx.restore();
      }

      // Scanlines.
      ctx.fillStyle = `rgba(0,0,0,${0.07 * env})`;
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);

      // The real text: colour fringes and jitter near the frontier, some frames.
      const hit = rand() < 0.4 * I * env;
      canvas.style.filter = hit ? fringe : "";
      for (const cell of c.cells) {
        const near = Math.abs(cell.x / W - p) < 0.3;
        cell.el.style.filter = hit && near ? fringe : "";
        cell.el.style.translate = hit && near ? `${((rand() - 0.5) * 6 * I).toFixed(1)}px 0` : "";
      }
    },
    cleanup: () => {
      canvas.style.filter = "";
      resetCells(c);
    },
  };
}

/** Fractal-noise ink soaking in, with a darker wet rim at its edge. */
function ink(c: Ctx): Effect {
  const { ctx, W, H, I, rand } = c;
  const s = 3;
  const w = Math.ceil(W / s), h = Math.ceil(H / s);
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d")!;
  const img = octx.createImageData(w, h);

  // Value noise, four octaves.
  const grid = 64;
  const lattice = Float32Array.from({ length: grid * grid }, () => rand());
  const smooth = (v: number) => v * v * (3 - 2 * v);
  const value = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const at = (i: number, j: number) => lattice[((j & (grid - 1)) * grid + (i & (grid - 1)))];
    const a = at(xi, yi), b = at(xi + 1, yi), c2 = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c2 - a) * yf + (a - b - c2 + d) * xf * yf;
  };
  const score = new Float32Array(w * h);
  const grain = new Float32Array(w * h);
  const base = 1 / (h * 0.9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, amp = 0.5, f = base, norm = 0;
      for (let o = 0; o < 4; o++) {
        n += amp * value(x * f, y * f);
        norm += amp;
        amp *= 0.5;
        f *= 2.1;
      }
      score[y * w + x] = (x / w) * 0.6 + (n / norm) * 0.4;
      grain[y * w + x] = rand();
    }
  }
  const rim: RGB = mix(c.next, [0, 0, 0], 0.22);
  const edge = 0.05;

  return {
    draw(_t, p) {
      const data = img.data;
      const target = p * 1.03;
      for (let i = 0; i < w * h; i++) {
        const d = score[i] - target;
        const o = i * 4;
        if (d > 0) {
          const a = d > 0.012 ? 1 : d / 0.012;
          data[o] = c.old[0];
          data[o + 1] = c.old[1];
          data[o + 2] = c.old[2];
          data[o + 3] = 255 * a;
        } else if (d > -edge) {
          const k = Math.pow(1 + d / edge, 2) * (0.35 + 0.45 * I) * (0.75 + grain[i] * 0.5);
          data[o] = rim[0];
          data[o + 1] = rim[1];
          data[o + 2] = rim[2];
          data[o + 3] = 255 * Math.min(1, k);
        } else {
          data[o + 3] = 0;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, 0, W, H);
    },
  };
}

const BAYER = [
  0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
].map((v) => (v + 0.5) / 64);

/** An ordered Bayer-matrix reveal, like an old monitor. */
function dither(c: Ctx): Effect {
  const { ctx, W, H, I } = c;
  const px = 3;
  const cols = Math.ceil(W / px), rows = Math.ceil(H / px);
  const band = 0.12 + 0.2 * I;
  return {
    draw(_t, p) {
      ctx.clearRect(0, 0, W, H);
      const rest = new Path2D();
      const glow = new Path2D();
      const front = p * (1 + band) - band;
      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++) {
          const threshold = front + BAYER[(r % 8) * 8 + (col % 8)] * band;
          const x = col / cols;
          if (x >= threshold) rest.rect(col * px, r * px, px, px);
          else if (x > threshold - 0.015) glow.rect(col * px, r * px, px, px);
        }
      }
      ctx.fillStyle = rgba(c.old);
      ctx.fill(rest);
      ctx.fillStyle = rgba(mix(c.next, [255, 255, 255], 0.55), 0.9);
      ctx.fill(glow);
    },
  };
}

/** A shock ring from the left edge with echoes and a glow; cells bob as each ring passes. */
function ripple(c: Ctx): Effect {
  const { ctx, W, H, I } = c;
  const cy = H / 2;
  const reach = Math.hypot(W, H) + 60;
  const spacing = 22 + 18 * I;
  return {
    draw(t, p) {
      const env = swell(t);
      const R = p * reach;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = rgba(c.old);
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(0, cy, Math.max(0, R), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      // A lit band just inside the leading ring.
      if (R > 2) {
        const g = ctx.createRadialGradient(0, cy, Math.max(0, R - 30), 0, cy, R);
        g.addColorStop(0, rgba(c.next, 0));
        g.addColorStop(1, rgba(mix(c.next, [255, 255, 255], 0.6), 0.55 * env));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, cy, R, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let k = 0; k < 3; k++) {
        const rk = R - k * spacing;
        if (rk <= 0) continue;
        ctx.beginPath();
        ctx.arc(0, cy, rk, 0, Math.PI * 2);
        ctx.lineWidth = (3 - k) * 1.3;
        ctx.strokeStyle = `rgba(255,255,255,${(0.8 - k * 0.25) * env})`;
        ctx.shadowColor = "rgba(255,255,255,0.8)";
        ctx.shadowBlur = k === 0 ? 8 : 0;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      for (const cell of c.cells) {
        const d = cell.x - R;
        const bob = Math.sin(d / 12) * Math.exp(-(d * d) / (2 * 38 * 38)) * 3 * I * env;
        cell.el.style.translate = `0 ${bob.toFixed(2)}px`;
      }
    },
    cleanup: () => resetCells(c),
  };
}

/** The new colour arrives as a swarm: each pixel cell flies in on an arc and lands in place. */
function particles(c: Ctx): Effect {
  const { ctx, W, H, I, rand } = c;
  const g = 7;
  const cols = Math.ceil(W / g), rows = Math.ceil(H / g);
  const flight = 0.32;
  const items = Array.from({ length: cols * rows }, (_, i) => {
    const tx = (i % cols) * g, ty = Math.floor(i / cols) * g;
    return {
      tx,
      ty,
      x0: -20 - rand() * W * 0.25,
      y0: H / 2 + (rand() - 0.5) * H * (1 + 2 * I),
      arc: (rand() - 0.5) * H * 2 * I,
      delay: (tx / W) * (1 - flight - 0.08) + rand() * 0.08,
      size: 1.5 + rand() * 2,
    };
  });
  const ease = (v: number) => 1 - Math.pow(1 - v, 3);
  return {
    draw(_t, p) {
      ctx.clearRect(0, 0, W, H);
      const rest = new Path2D();
      ctx.fillStyle = rgba(c.next);
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 3;
      for (const it of items) {
        const local = (p - it.delay) / flight;
        if (local >= 1) continue;
        rest.rect(it.tx, it.ty, g, g);
        if (local <= 0) continue;
        const k = ease(local);
        const mx = (it.x0 + it.tx) / 2, my = (it.y0 + it.ty) / 2 + it.arc;
        const x = (1 - k) * (1 - k) * it.x0 + 2 * (1 - k) * k * mx + k * k * it.tx;
        const y = (1 - k) * (1 - k) * it.y0 + 2 * (1 - k) * k * my + k * k * it.ty;
        const s = it.size + (g - it.size) * k;
        ctx.fillRect(x, y, s, s);
      }
      ctx.shadowBlur = 0;
      // Paint the old colour behind the flying pixels.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = rgba(c.old);
      ctx.fill(rest);
      ctx.globalCompositeOperation = "source-over";
    },
  };
}

const EFFECTS: Record<CanvasStyle, (c: Ctx) => Effect> = {
  liquid,
  "pixel-glitch": pixelGlitch,
  ink,
  dither,
  ripple,
  particles,
};

// ---------------------------------------------------------------- runner

/** Plays a canvas effect inside `layer` (an absolutely positioned layer of the row). */
export function playCanvasReveal(tr: HTMLElement, layer: HTMLElement, style: CanvasStyle, o: CanvasRevealOptions): Playing {
  const W = tr.offsetWidth, H = tr.offsetHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(W * dpr);
  canvas.height = Math.ceil(H * dpr);
  canvas.style.cssText = `position:absolute;inset:0;width:${W}px;height:${H}px`;
  layer.innerHTML = "";
  layer.style.display = "block";
  layer.style.transform = "";
  layer.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  // Mirroring flips the drawing, so every effect can think left to right.
  if (o.mirrored) ctx.setTransform(-dpr, 0, 0, dpr, W * dpr, 0);
  else ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cells = (Array.from(tr.children) as HTMLElement[])
    .filter((el) => el.tagName === "TD")
    .map((el) => {
      const x = el.offsetLeft + el.offsetWidth / 2;
      return { el, x: o.mirrored ? W - x : x };
    });
  const c: Ctx = {
    ctx,
    canvas,
    W,
    H,
    dpr,
    old: resolveRgb(tr, o.oldColor),
    next: resolveRgb(tr, o.newColor),
    I: clamp01(o.intensity),
    cells,
    rand: seeded(Math.floor(Math.random() * 1e9)),
  };
  const effect = EFFECTS[style](c);
  const ease = bezierFn(o.easing);

  // The old colour covers the row from the very first frame.
  effect.draw(0, 0, 0, 0);

  const finished = new Promise<void>((resolve) => {
    const start = performance.now();
    let last = start;
    const frame = (now: number) => {
      if (!canvas.isConnected) {
        effect.cleanup?.();
        return resolve();
      }
      const ms = now - start;
      const t = Math.min(1, ms / o.duration);
      effect.draw(t, ease(t), (now - last) / 1000, ms);
      last = now;
      if (t < 1) requestAnimationFrame(frame);
      else {
        effect.cleanup?.();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
  return { finished };
}
