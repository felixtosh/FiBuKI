/**
 * Drop-in for `firebase-functions/v2/https`: callable/request registration
 * that returns directly invocable functions instead of deploying Cloud
 * Functions. This is the seed of the selfhost HTTP host — the route wrapper
 * will walk the index.ts barrel exports and mount anything carrying
 * `__selfhostCallable` / `__selfhostRequest`.
 *
 * Mirrors the firebase-functions v2 unit-test convention: the returned
 * value exposes `.run(request)` which invokes the raw handler (auth checks
 * and all — createCallable's wrapper body runs unmodified).
 */

// ---------------------------------------------------------------------------
// HttpsError (same public shape as firebase-functions/v2/https)
// ---------------------------------------------------------------------------

export type FunctionsErrorCode =
  | "ok"
  | "cancelled"
  | "unknown"
  | "invalid-argument"
  | "deadline-exceeded"
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "resource-exhausted"
  | "failed-precondition"
  | "aborted"
  | "out-of-range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data-loss"
  | "unauthenticated";

export class HttpsError extends Error {
  public readonly code: FunctionsErrorCode;
  public readonly details?: unknown;

  constructor(code: FunctionsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HttpsError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface AuthData {
  uid: string;
  token?: Record<string, unknown>;
}

export interface CallableRequest<T = unknown> {
  data: T;
  auth?: AuthData;
  rawRequest?: unknown;
  acceptsStreaming?: boolean;
}

type CallableHandler<T, R> = (request: CallableRequest<T>) => R | Promise<R>;
type RequestHandler = (req: unknown, res: unknown) => void | Promise<void>;

export interface CallableFunction<T = unknown, R = unknown> {
  (request: CallableRequest<T>): Promise<R>;
  run(request: CallableRequest<T>): Promise<R>;
  __selfhostCallable: { opts: Record<string, unknown> };
}

export interface HttpsFunction {
  (req: unknown, res: unknown): void | Promise<void>;
  __selfhostRequest: { opts: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Registration API (mirrors firebase-functions/v2/https)
// ---------------------------------------------------------------------------

type Opts = Record<string, unknown>;

export function onCall<T = unknown, R = unknown>(
  optsOrHandler: Opts | CallableHandler<T, R>,
  maybeHandler?: CallableHandler<T, R>,
): CallableFunction<T, Awaited<R>> {
  const handler = (
    typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler
  ) as CallableHandler<T, R>;
  const opts = typeof optsOrHandler === "function" ? {} : optsOrHandler;

  const fn = async (request: CallableRequest<T>) => handler(request);
  return Object.assign(fn, {
    run: fn,
    __selfhostCallable: { opts },
  }) as CallableFunction<T, Awaited<R>>;
}

export function onRequest(
  optsOrHandler: Opts | RequestHandler,
  maybeHandler?: RequestHandler,
): HttpsFunction {
  const handler = (
    typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler
  ) as RequestHandler;
  const opts = typeof optsOrHandler === "function" ? {} : optsOrHandler;

  const fn = (req: unknown, res: unknown) => handler(req, res);
  return Object.assign(fn, { __selfhostRequest: { opts } });
}
