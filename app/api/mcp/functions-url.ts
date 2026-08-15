/**
 * Resolve the functions origin the /api/mcp proxies forward to.
 *
 * On a self-host build there is no Cloud Functions project to fall back to.
 * The previous fallback silently proxied every request — API key included —
 * to the SaaS production functions, which answered 401 "Invalid or expired
 * API key" for keys that only exist in the self-host database, a failure
 * indistinguishable from a local auth bug. Refuse loudly instead: the deploy
 * must provide NEXT_PUBLIC_FUNCTIONS_URL (deploy/selfhost/docker-compose.yml
 * defaults it to the internal fibuki-api service URL).
 *
 * Returns null when no origin can be resolved; callers answer 500 with a
 * configuration error rather than proxying anywhere.
 */
export function resolveFunctionsUrl(fnName: string): string | null {
  const base = process.env.NEXT_PUBLIC_FUNCTIONS_URL;
  if (base) return `${base.replace(/\/$/, "")}/${fnName}`;
  if (process.env.NEXT_PUBLIC_FIBUKI_BACKEND === "selfhost") return null;
  return `https://europe-west1-${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "taxstudio-f12fb"}.cloudfunctions.net/${fnName}`;
}

export const FUNCTIONS_URL_UNSET_ERROR =
  "NEXT_PUBLIC_FUNCTIONS_URL is not configured. This self-host deployment " +
  "refuses to fall back to the SaaS production functions; set it to the " +
  "fibuki-api origin (the compose file defaults it to http://fibuki-api:8788).";
