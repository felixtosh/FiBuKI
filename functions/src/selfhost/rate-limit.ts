/**
 * Rate limiting for the selfhost HTTP surface — a DoS/bruteforce backstop,
 * not a quota system. One limiter instance per plane (callables, data plane,
 * blob plane), fixed one-minute window, keyed by source IP.
 *
 * Behind the OIDC proxy every request can share the proxy's IP unless
 * express "trust proxy" is configured; per-source granularity degrading to
 * per-proxy is acceptable for a backstop, so the X-Forwarded-For validation
 * (which would throw on proxied requests without trust-proxy) is disabled.
 *
 * ## Why the data plane's cap is not a small number
 *
 * The client shim polls: every `onSnapshot` is a request every
 * NEXT_PUBLIC_FIBUKI_POLL_MS (2.5s by default), and a single view holds tens of
 * live listeners. One transactions tab therefore sits in the high hundreds of
 * requests per minute before the user touches anything. A cap sized for "a human
 * clicking" is a cap the app trips on its own, and because the limiter is keyed by
 * IP behind a proxy, one busy tab exhausts the bucket for every other client too.
 *
 * ## Why tripping it is logged
 *
 * A 429 reaches the browser as a failed listener, which the app renders as its
 * generic error state — "Failed to load transactions" and nothing else. Without a
 * server-side line, the only evidence the limiter fired at all is a RateLimit
 * header on a request nobody captured. One line per plane per window is cheap and
 * turns a mystery into a diagnosis.
 *
 * FIBUKI_RATE_LIMIT_MAX overrides the per-minute cap for ALL planes; 0
 * disables limiting (load tests).
 */

import rateLimit from "express-rate-limit";
import type { Request, RequestHandler, Response } from "express";

/** Suppress repeat log lines for the same plane inside one window. */
const WINDOW_MS = 60_000;
const lastLoggedAt = new Map<string, number>();

function logTrip(plane: string, limit: number, req: Request): void {
  const now = Date.now();
  const last = lastLoggedAt.get(plane) ?? 0;
  if (now - last < WINDOW_MS) return;
  lastLoggedAt.set(plane, now);
  console.warn(
    `selfhost rate-limit: ${plane} plane hit its cap of ${limit}/min from ${req.ip ?? "unknown"} ` +
      `(${req.method} ${req.originalUrl}). Clients see this as a failed request with no ` +
      `explanation; raise FIBUKI_RATE_LIMIT_MAX if this is normal traffic for this deployment.`,
  );
}

/** Test seam — the suppression map is module state. */
export function __resetRateLimitLog(): void {
  lastLoggedAt.clear();
}

export function makeRateLimiter(defaultPerMinute: number, plane = "unnamed"): RequestHandler {
  const env = process.env.FIBUKI_RATE_LIMIT_MAX;
  const max = env !== undefined ? Number(env) : defaultPerMinute;
  if (!Number.isFinite(max) || max <= 0) {
    if (env !== undefined && env !== "0") {
      console.warn(`selfhost rate-limit: ignoring invalid FIBUKI_RATE_LIMIT_MAX="${env}"`);
    }
    if (env === "0") return (_req, _res, next) => next();
  }
  const limit = Number.isFinite(max) && max > 0 ? max : defaultPerMinute;
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    // The default handler answers in plain text, which every client in this repo
    // discards — it parses the JSON error shape and falls back to `statusText`,
    // empty on HTTP/2. Answer in the shape the clients actually read.
    handler: (req: Request, res: Response) => {
      logTrip(plane, limit, req);
      res.setHeader("Retry-After", Math.ceil(WINDOW_MS / 1000));
      res.status(429).json({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: `Too many requests: this deployment allows ${limit} per minute. Retry shortly.`,
        },
      });
    },
  });
}
