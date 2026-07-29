/**
 * The fibuki-api HTTP host (work item 3): an Express app that walks the
 * index.ts barrel exports and mounts everything the https-shim marked —
 * `__selfhostCallable` behind the Firebase callable wire protocol,
 * `__selfhostRequest` as plain Express handlers (they are written against
 * Express req/res already; firebase-functions v2 onRequest IS Express).
 *
 * Callable wire protocol (matches the firebase-functions client contract,
 * so the future client-SDK shim can reuse `callFunction()` unmodified):
 *   POST /<exportName>   body { data: ... }   Authorization: Bearer <token>
 *   200 → { result: ... }
 *   error → mapped HTTP status, body { error: { message, status, details? } }
 *
 * Auth is pluggable: the host takes a TokenVerifier (production: Authentik
 * OIDC; tests: fake). A missing Authorization header yields request.auth
 * undefined and lets the callable decide (createCallable throws
 * unauthenticated unless allowUnauthenticated) — same as Firebase. An
 * INVALID token is rejected at the host, stricter than Firebase's
 * "treat as anonymous", deliberately.
 */

import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { toNodeHandler } from "better-auth/node";
import type { AuthData, CallableFunction, FunctionsErrorCode, HttpsFunction } from "./https-shim";
import { HttpsError } from "./https-shim";
import { EXCLUDED_EXPORTS } from "./manifest";
import { createDataPlane } from "./data-plane";
import { createStorageRoutes } from "./storage-routes";
import { makeRateLimiter } from "./rate-limit";

export type TokenVerifier = (token: string) => Promise<AuthData | null>;

export interface CreateHostOptions {
  verifyToken: TokenVerifier;
  /**
   * Built-in auth endpoints (W1 chunk 3): a WHATWG-fetch handler (Better
   * Auth's) mounted at /__auth — same collision-free namespace trick as
   * /__data. Absent when identity comes from an external OIDC front or the
   * dev bypass; then /__auth stays a plain not-found.
   */
  authHandler?: (req: globalThis.Request) => Promise<globalThis.Response>;
  /** Barrel exports NOT to mount. Defaults to manifest EXCLUDED_EXPORTS. */
  exclude?: ReadonlySet<string>;
  /** JSON body limit for callable payloads (CSV imports are chunky). */
  jsonLimit?: string;
  /**
   * Browser origins allowed to call the host cross-origin (fibuki-web when it
   * is served from a different origin than fibuki-api). Each entry is matched
   * exactly against the request `Origin`, or pass `"*"` to reflect any origin.
   * Defaults to FIBUKI_WEB_ORIGIN (comma-separated) or, if unset, `"*"` — safe
   * because the host authenticates via a Bearer token, never cookies, so it
   * never sets Access-Control-Allow-Credentials. Same-origin deployments (one
   * reverse proxy) can leave this unset and no CORS headers are emitted.
   */
  corsOrigins?: string[] | "*";
  log?: (message: string) => void;
}

export interface HostInventory {
  callables: string[];
  requests: string[];
  scheduled: string[];
  excluded: string[];
}

// Canonical gRPC-code → HTTP status mapping used by Cloud Functions callables.
const CODE_TO_HTTP: Record<FunctionsErrorCode, number> = {
  ok: 200,
  cancelled: 499,
  unknown: 500,
  "invalid-argument": 400,
  "deadline-exceeded": 504,
  "not-found": 404,
  "already-exists": 409,
  "permission-denied": 403,
  "resource-exhausted": 429,
  "failed-precondition": 400,
  aborted: 409,
  "out-of-range": 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  "data-loss": 500,
  unauthenticated: 401,
};

function wireStatus(code: FunctionsErrorCode): string {
  return code.toUpperCase().replace(/-/g, "_");
}

function sendError(res: Response, code: FunctionsErrorCode, message: string, details?: unknown) {
  res
    .status(CODE_TO_HTTP[code] ?? 500)
    .json({ error: { message, status: wireStatus(code), ...(details !== undefined ? { details } : {}) } });
}

function isCallable(v: unknown): v is CallableFunction {
  return typeof v === "function" && "__selfhostCallable" in v;
}

function isRequestFn(v: unknown): v is HttpsFunction {
  return typeof v === "function" && "__selfhostRequest" in v;
}

function isScheduled(v: unknown): boolean {
  return typeof v === "object" && v !== null && "__selfhostSchedule" in v;
}

export function createHost(
  barrel: Record<string, unknown>,
  options: CreateHostOptions,
): { app: Express; inventory: HostInventory } {
  const exclude = options.exclude ?? EXCLUDED_EXPORTS;
  const log = options.log ?? (() => undefined);
  const app = express();

  // CORS: fibuki-web may be served from a different origin than fibuki-api.
  // Auth is a Bearer token (never a cookie), so we never set
  // Access-Control-Allow-Credentials and `*` is a safe default. Mounted before
  // every route so preflights to callables and the data/blob planes all pass.
  const corsCfg =
    options.corsOrigins ??
    (process.env.FIBUKI_WEB_ORIGIN
      ? process.env.FIBUKI_WEB_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
      : "*");
  const allowAnyOrigin = corsCfg === "*";
  const allowedOrigins = allowAnyOrigin ? null : new Set(corsCfg);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      // Reflected per-request → caches must key on Origin. Set even for a
      // disallowed origin so a headerless response can't later be served from
      // cache to an allowed one.
      res.setHeader("Vary", "Origin");
    }
    if (origin && (allowAnyOrigin || allowedOrigins!.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      // x-fibuki-custom carries base64-JSON custom metadata on storage uploads
      // (storage-client.ts → storage-routes.ts); a split-origin upload preflight
      // must allow it or the browser blocks the PUT.
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-fibuki-custom");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      // Preflight — answer here whether or not the origin was allowed (a
      // disallowed origin just gets no ACAO header and the browser blocks it).
      res.status(204).end();
      return;
    }
    next();
  });

  // Cloud Functions pre-parses JSON/urlencoded bodies and keeps the raw
  // bytes on req.rawBody; some onRequest handlers (webhooks) rely on that.
  const captureRaw = (req: Request, _res: Response, buf: Buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  };
  const jsonParser = express.json({ limit: options.jsonLimit ?? "32mb", verify: captureRaw });
  const urlencodedParser = express.urlencoded({ extended: true, verify: captureRaw });

  const inventory: HostInventory = { callables: [], requests: [], scheduled: [], excluded: [] };

  // One shared bucket across all callable/request routes (per source IP).
  const limiter = makeRateLimiter(600);

  const bearerToken = (req: Request): string | undefined => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return header.slice("Bearer ".length);
  };

  for (const [name, value] of Object.entries(barrel)) {
    if (exclude.has(name)) {
      if (isCallable(value) || isRequestFn(value) || isScheduled(value)) {
        inventory.excluded.push(name);
      }
      continue;
    }

    if (isCallable(value)) {
      inventory.callables.push(name);
      app.post(`/${name}`, limiter, jsonParser, async (req: Request, res: Response) => {
        try {
          // Auth here mirrors Firebase onCall: any PRESENTED token is always
          // verified and a bad one is always rejected; a request may omit the
          // token entirely, in which case auth stays undefined and the
          // per-function policy decides (createCallable throws unauthenticated
          // unless the callable opted into allowUnauthenticated, e.g. public
          // bank listing). The transport cannot require a token without
          // breaking those public callables.
          const token = bearerToken(req);
          const verified = token === undefined ? undefined : await options.verifyToken(token);
          if (verified === null) {
            sendError(res, "unauthenticated", "Invalid authentication token.");
            return;
          }
          const auth: AuthData | undefined = verified;

          const body: unknown = req.body;
          if (typeof body !== "object" || body === null || !("data" in body)) {
            sendError(res, "invalid-argument", "Request body must be JSON of shape { data: ... }.");
            return;
          }

          const result = await value.run({
            data: (body as { data: unknown }).data,
            auth,
            rawRequest: req,
          });
          res.status(200).json({ result: result ?? null });
        } catch (err) {
          if (err instanceof HttpsError) {
            sendError(res, err.code, err.message, err.details);
          } else {
            log(`callable ${name} crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            sendError(res, "internal", "INTERNAL");
          }
        }
      });
      continue;
    }

    if (isRequestFn(value)) {
      inventory.requests.push(name);
      // app.use strips the mount path, so req.path inside the handler is
      // relative to the function root — same as Cloud Functions.
      app.use(
        `/${name}`,
        limiter,
        jsonParser,
        urlencodedParser,
        (req: Request, res: Response, next: NextFunction) => {
          Promise.resolve(value(req, res)).catch(next);
        },
      );
      continue;
    }

    if (isScheduled(value)) {
      inventory.scheduled.push(name);
      // Mounted by the cron host (work item 4), not over HTTP.
    }
    // Triggers registered themselves on the in-process bus at import time.
  }

  // Built-in auth endpoints (W1 chunk 3): Better Auth's fetch handler
  // behind the same per-IP rate limiter as the callables (sign-in is the
  // brute-forceable surface). No jsonParser here — the adapter streams the
  // raw node request into a fetch Request itself, and a pre-consumed body
  // would hang it. "__auth" can't collide with barrel exports for the same
  // reason "__data" can't (see below).
  if (options.authHandler) {
    app.all(["/__auth", "/__auth/*"], limiter, toNodeHandler(options.authHandler));
  }

  // Client data plane (work item 6): query/get/write for the frontend
  // firestore shim. "__data" can't collide with barrel exports (JS
  // identifiers don't start with "__d" in the barrel — and the loop above
  // mounted its routes first anyway).
  app.use("/__data", createDataPlane(options.verifyToken, { jsonLimit: options.jsonLimit }));

  // Client blob plane (work item 6, slice C): upload/download/delete for the
  // frontend storage shim. "__storage" can't collide with barrel exports for
  // the same reason "__data" can't (see above).
  app.use("/__storage", createStorageRoutes(options.verifyToken, { jsonLimit: options.jsonLimit }));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      callables: inventory.callables.length,
      requests: inventory.requests.length,
      scheduled: inventory.scheduled.length,
      excluded: inventory.excluded.length,
    });
  });

  // Anything unmounted (unknown names, excluded exports, GET on a callable)
  // gets a callable-protocol NOT_FOUND so the client shim sees one shape.
  app.use((_req: Request, res: Response) => {
    sendError(res, "not-found", "NOT_FOUND");
  });

  // Express error handler signature requires 4 args.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(`request handler crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (!res.headersSent) sendError(res, "internal", "INTERNAL");
  });

  return { app, inventory };
}
