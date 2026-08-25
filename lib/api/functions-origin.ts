/**
 * Where the callable/HTTP backend lives, for code running in the web container.
 *
 * There is exactly one answer and it comes from the environment. Every default
 * this replaced pointed at `europe-west1-<project>.cloudfunctions.net`, which is
 * wrong twice over: a self-host deployment has no such project, and the hosted
 * product no longer runs there either. A wrong default does not fail — it sends
 * the request, bearer token included, to somebody else's backend and returns an
 * error indistinguishable from a local auth bug.
 *
 * `NEXT_PUBLIC_FUNCTIONS_URL` is an origin this container can reach; compose
 * defaults it to the internal `http://fibuki-api:8788`. It is NOT a public
 * address, so never put it in an email or an API spec — those want
 * `FIBUKI_PUBLIC_URL` (see functions/src/utils/publicOrigin.ts).
 *
 * Returns null when nothing is configured. Callers refuse loudly; they never
 * guess.
 */

/** The configured backend origin, without a trailing slash, or null. */
export function functionsOrigin(): string | null {
  const base = process.env.NEXT_PUBLIC_FUNCTIONS_URL;
  if (!base) return null;
  return base.replace(/\/$/, "");
}

/** Full URL for one function, or null when no origin is configured. */
export function functionsUrl(fnName: string): string | null {
  const origin = functionsOrigin();
  return origin ? `${origin}/${fnName}` : null;
}

/** @deprecated Use functionsUrl. Kept so the MCP proxies read unchanged. */
export const resolveFunctionsUrl = functionsUrl;

export const FUNCTIONS_URL_UNSET_ERROR =
  "NEXT_PUBLIC_FUNCTIONS_URL is not configured. This deployment refuses to fall " +
  "back to Cloud Functions; set it to the fibuki-api origin (the compose file " +
  "defaults it to http://fibuki-api:8788).";
