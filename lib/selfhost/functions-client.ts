/**
 * Self-host client Callable shim (work item 6, slice C).
 *
 * Drop-in replacement for the subset of `firebase/functions` the app uses
 * (`getFunctions`, `connectFunctionsEmulator`, `httpsCallable`), swapped at
 * module-resolution time the same way as the firestore-client shim
 * (lib/selfhost/firestore-client.ts) — env-gated, FIBUKI_BACKEND=selfhost,
 * zero app-code changes.
 *
 * Speaks the callable wire protocol the host implements
 * (functions/src/selfhost/host.ts):
 *   POST /<name>   body { data: ... }   Authorization: Bearer <token>
 *   200 -> { result: ... }
 *   error -> mapped HTTP status, body { error: { message, status, details? } }
 *
 * Deliberately self-contained: the transport/post() plumbing is duplicated
 * from firestore-client.ts rather than imported, since the two shims alias
 * to different upstream modules (firebase/functions vs firebase/firestore)
 * at build time and must not create a cross-dependency between them.
 */

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

export interface FunctionsClientTransport {
  /** Base URL of fibuki-api, e.g. https://api.fibuki.home (no trailing slash). */
  apiUrl: string;
  /** Bearer token source. The auth shim (slice D) wires this to Authentik. */
  getToken: () => Promise<string | null> | string | null;
}

let _transport: FunctionsClientTransport | null = null;

/**
 * Wire the callable transport. Called by the auth shim once the token
 * source exists, and by tests to point at a booted host. Without it, the
 * env fallback (NEXT_PUBLIC_FIBUKI_API_URL + a token getter set via
 * __setFunctionsClientToken) is used.
 */
export function __configureFunctionsClient(t: FunctionsClientTransport): void {
  _transport = t;
}

let _envTokenGetter: FunctionsClientTransport["getToken"] = () => null;
/** Env-fallback token source (auth shim sets this if it doesn't configure the whole transport). */
export function __setFunctionsClientToken(getToken: FunctionsClientTransport["getToken"]): void {
  _envTokenGetter = getToken;
}

function transport(): FunctionsClientTransport {
  if (_transport) return _transport;
  const apiUrl =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_FIBUKI_API_URL) || "";
  if (apiUrl) {
    _transport = { apiUrl: apiUrl.replace(/\/$/, ""), getToken: () => _envTokenGetter() };
    return _transport;
  }
  throw new FunctionsError(
    "failed-precondition",
    "Functions client not configured: set NEXT_PUBLIC_FIBUKI_API_URL or call __configureFunctionsClient().",
  );
}

const CODE_BY_HTTP: Record<number, string> = {
  400: "invalid-argument",
  401: "unauthenticated",
  403: "permission-denied",
  404: "not-found",
  409: "aborted",
  500: "internal",
};

async function post(name: string, data: unknown): Promise<any> {
  const t = transport();
  const token = await t.getToken();
  const res = await fetch(`${t.apiUrl}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    let message = res.statusText;
    let statusCode = "";
    let details: unknown;
    try {
      const j = await res.json();
      if (j?.error?.message) message = j.error.message;
      if (j?.error?.status) statusCode = j.error.status;
      if (j?.error && "details" in j.error) details = j.error.details;
    } catch {
      /* non-JSON body — fall back to HTTP status */
    }
    const code = statusCode
      ? statusCode.toLowerCase().replace(/_/g, "-")
      : CODE_BY_HTTP[res.status] ?? "unknown";
    throw new FunctionsError(code, message, details);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Mirrors the FirebaseError shape the app checks (`err.code`, `err.name`). */
export class FunctionsError extends Error {
  readonly name = "FirebaseError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Functions instance + no-ops                                        */
/* ------------------------------------------------------------------ */

export interface Functions {
  readonly __fibukiFunctions: true;
}

const _functions: Functions = { __fibukiFunctions: true };

/** getFunctions(app?, region?) — region is accepted (config.ts passes "europe-west1") and ignored. */
export function getFunctions(_app?: unknown, _region?: string): Functions {
  return _functions;
}

export function connectFunctionsEmulator(_functions: unknown, _host: string, _port: number): void {
  /* no-op: the selfhost client talks to fibuki-api, never an emulator */
}

/* ------------------------------------------------------------------ */
/* httpsCallable                                                       */
/* ------------------------------------------------------------------ */

export interface HttpsCallableResult<Res = unknown> {
  readonly data: Res;
}

export type HttpsCallable<Req = unknown, Res = unknown> = (data: Req) => Promise<HttpsCallableResult<Res>>;

export function httpsCallable<Req = unknown, Res = unknown>(
  _functions: unknown,
  name: string,
  _options?: unknown,
): HttpsCallable<Req, Res> {
  return async (data: Req): Promise<HttpsCallableResult<Res>> => {
    const r = await post(name, data);
    return { data: r.result };
  };
}
