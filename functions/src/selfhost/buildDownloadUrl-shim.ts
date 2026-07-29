/**
 * Self-host replacement for functions/src/utils/buildDownloadUrl.ts.
 *
 * The upstream helper builds googleapis.com Storage URLs; in the self-host
 * build there is no Firebase Storage, so both helpers instead emit a URL that
 * the host's blob plane serves:
 *
 *   ${FIBUKI_PUBLIC_URL}/__storage/download/<per-segment-encoded-path>
 *
 * matching the shape the client storage shim's getDownloadURL() produces
 * (lib/selfhost/storage-client.ts) and the host download route
 * (functions/src/selfhost/storage-routes.ts `GET /__storage/download/*`), so a
 * download-URL string written into Firestore by the backend resolves against
 * the same route a client-side upload does. Aliased in via
 * vitest.selfhost.config.ts (whole-specifier regex, same as the mailer shim).
 *
 * Note on auth: the Firebase `downloadToken` is meaningless to the host (it
 * verifies Authentik tokens, not Storage tokens), so it is NOT embedded here.
 * Backend-written links are opened by an already-authenticated browser session
 * (Bearer) or fetched through the client shim; the download route's `?token=`
 * path is for the client shim's own id-token, not this. See
 * frontend-shim-design.md §2.6a.
 */

/**
 * Public base of fibuki-api. FIBUKI_PUBLIC_URL when set (required for a
 * split-origin deployment where the link is opened outside fibuki-api); else
 * empty, yielding a root-relative `/__storage/download/...` that resolves
 * same-origin (the common single-reverse-proxy deployment). Deliberately does
 * NOT throw — this helper sits deep in many write flows, and a throw would
 * break unrelated pipelines rather than degrade to a working same-origin link.
 */
function base(): string {
  return (process.env.FIBUKI_PUBLIC_URL || "").replace(/\/$/, "");
}

/** Per-segment encode, preserving `/` — mirrors storage-client.ts + the host route. */
function encodePath(storagePath: string): string {
  return storagePath.split("/").map(encodeURIComponent).join("/");
}

function hostDownloadUrl(storagePath: string): string {
  return `${base()}/__storage/download/${encodePath(storagePath)}`;
}

// Signatures match the upstream helper exactly (callers pass positionally).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildDownloadUrl(_bucketName: string, storagePath: string, _downloadToken: string): string {
  return hostDownloadUrl(storagePath);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildStorageObjectUrl(
  _bucketName: string,
  storagePath: string,
  _opts?: { cacheBust?: boolean },
): string {
  return hostDownloadUrl(storagePath);
}
