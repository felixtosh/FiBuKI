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

/**
 * Longest a single request-derived value may be in the log line. A URL is
 * unbounded; the diagnostic value is in its prefix.
 */
const MAX_LOGGED_VALUE = 200;

/**
 * Neutralise a request-controlled value before it reaches a log line.
 *
 * `req.originalUrl` is whatever the client put on the request line, and Express
 * does not strip newlines from it. Interpolated raw, a CR or LF forges entries an
 * operator reads as separate, genuine log lines — and anything parsing the log
 * line-by-line believes them (CodeQL js/log-injection, alert #297).
 *
 * Stripping the newlines is the fix rather than dropping the line: the line exists
 * because a 429 is otherwise invisible — it reaches the browser as a generic
 * "Failed to load" with no server-side trace at all. Every C0/C1 control character
 * goes, not just CR/LF, because a lone \r, a NUL or an ANSI escape all corrupt a
 * terminal or a log viewer in their own way.
 */
function forLog(value: unknown, max = MAX_LOGGED_VALUE): string {
  const text = String(value ?? "unknown")
    // Each newline gets its OWN global replace with a single-constant pattern.
    // This shape is load-bearing, not style: CodeQL reads the replaced string off
    // a constant regex root, so a \u-escaped character-class RANGE covering \n
    // does not register (alert #298, first attempt) and neither does an
    // alternation `/\r|\n/g` (second attempt) — an alternation root yields no
    // matched string at all. Same lesson #181 recorded for
    // js/remote-property-injection: the guard has to be in the shape the rule
    // recognises, not merely correct. Do not "simplify" these two lines into one.
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
    // Then the rest: a NUL, a backspace or an ANSI escape each corrupt a terminal
    // or a log viewer in their own way, and none of them are newlines.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function logTrip(plane: string, limit: number, req: Request): void {
  const now = Date.now();
  const last = lastLoggedAt.get(plane) ?? 0;
  if (now - last < WINDOW_MS) return;
  lastLoggedAt.set(plane, now);
  // `plane` and `limit` are ours; everything off `req` goes through forLog().
  console.warn(
    `selfhost rate-limit: ${plane} plane hit its cap of ${limit}/min from ${forLog(req.ip)} ` +
      `(${forLog(req.method, 16)} ${forLog(req.originalUrl)}). Clients see this as a failed ` +
      `request with no explanation; raise FIBUKI_RATE_LIMIT_MAX if this is normal traffic ` +
      `for this deployment.`,
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
