/**
 * A route that writes through a callable runs it as its caller: it forwards
 * the caller's Bearer token (callFirebaseFunction), so the callable's own
 * checks decide, never the route. The writers behind the callables cannot run
 * inside the web container (they reach `firebase-functions`), so this is how
 * a route reaches them (#813).
 */

/** The caller's Bearer token, or undefined when the request has none. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || undefined : undefined;
}

/**
 * What a failed callable said. callFirebaseFunction throws
 * `Firebase function <name> failed: <status> - <body>`, the body the
 * callable protocol's `{ error: { message } }`.
 */
export function callableErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const body = text.match(/failed: \d+ - ([\s\S]*)$/)?.[1];
  if (body) {
    try {
      const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === "string" && message) return message;
    } catch {
      // not JSON: the text as it came
    }
  }
  return text;
}
