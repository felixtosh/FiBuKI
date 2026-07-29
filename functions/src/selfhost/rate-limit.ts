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
 * FIBUKI_RATE_LIMIT_MAX overrides the per-minute cap for ALL planes; 0
 * disables limiting (load tests).
 */

import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

export function makeRateLimiter(defaultPerMinute: number): RequestHandler {
  const env = process.env.FIBUKI_RATE_LIMIT_MAX;
  const max = env !== undefined ? Number(env) : defaultPerMinute;
  if (!Number.isFinite(max) || max <= 0) {
    if (env !== undefined && env !== "0") {
      console.warn(`selfhost rate-limit: ignoring invalid FIBUKI_RATE_LIMIT_MAX="${env}"`);
    }
    if (env === "0") return (_req, _res, next) => next();
  }
  return rateLimit({
    windowMs: 60_000,
    limit: Number.isFinite(max) && max > 0 ? max : defaultPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  });
}
