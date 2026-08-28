/**
 * Classifying a STORED download URL: can the browser load it on its own, and if
 * not, may we attach the user's id token to fetch it?
 *
 * Firebase Storage URLs are self-authenticating. The stored string carries its
 * own durable `token=`, so `<a href={file.downloadUrl} download>` and
 * `<iframe src=…>` both just work, and every surface in the app was written
 * against that property. The self-host blob plane does not have it:
 * `/__storage/download/<path>` requires an Authorization header, and
 * `functions/src/selfhost/buildDownloadUrl-shim.ts` deliberately embeds no
 * token, because a backend-written URL is persisted into a document and a
 * bearer credential in there would be copied into every backup and would expire
 * within the hour anyway.
 *
 * Viewers already solved this by fetching with a header and rendering a blob
 * (hooks/use-file-object-url.ts). Anchors did not, which is #206: the export
 * succeeds, the row appears, and the link returns UNAUTHENTICATED.
 *
 * These predicates are the shared half of both answers. Pure and free of
 * browser globals on purpose, so the self-host suite can pin them.
 *
 * ## Decisions are made on the HOST, never on a substring
 *
 * The first version of this module asked `url.includes("…googleapis.com")`,
 * which CodeQL correctly rejected as incomplete URL sanitization
 * (js/incomplete-url-substring-sanitization). Both directions of that mistake
 * matter, and the second one is the dangerous one:
 *
 *   - `https://evil.example/?x=firebasestorage.googleapis.com` reads as
 *     self-authenticating, so a credential-needing URL is handed to the browser
 *     and silently fails to load.
 *   - `https://firebasestorage.googleapis.com.evil.example/o/f` reads as a
 *     Firebase host, and anything NOT matching gets fetched with the user's id
 *     token in an Authorization header. Substring logic therefore decides where
 *     a live credential is sent.
 *
 * So hosts are parsed and compared exactly, and `isCredentialTarget` gates the
 * header separately: the token goes to our own origin and our own API host, and
 * nowhere else, whatever a stored document happens to contain.
 */

/**
 * Parsing base for a root-relative stored URL. `FIBUKI_PUBLIC_URL` is empty in
 * the common single-reverse-proxy deployment, so the shim emits
 * `/__storage/download/…` and these helpers must not choke on it. Never
 * dereferenced, and never string-compared: only used to make `new URL` accept a
 * relative path. `.invalid` is reserved by RFC 2606 and cannot resolve.
 */
const RELATIVE_BASE = "http://relative.invalid";
const RELATIVE_HOST = "relative.invalid";

/** Hosts whose URLs carry their own durable download token. */
const SELF_AUTHENTICATING_HOSTS = new Set([
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
]);

/** True for `/path` but not for `//host/path`, which carries a host of its own. */
function isRootRelative(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** Lower-cased hostname, or null if the string will not parse as a URL at all. */
function hostOf(url: string): string | null {
  try {
    return new URL(url, RELATIVE_BASE).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the browser can load this URL with no credentials from us.
 *
 * A self-host `?token=` URL is deliberately NOT self-authenticating, even though
 * the download route accepts one. Those tokens are id tokens that expire within
 * the hour, so trusting a stored one means a link that silently starts 401ing.
 * Re-requesting with a live header always works. `getDownloadURL` no longer
 * mints them, but migrated and previously stored documents still hold them.
 */
export function isSelfAuthenticating(url: string): boolean {
  if (url.startsWith("blob:") || url.startsWith("data:")) return true;
  const host = hostOf(url);
  return host !== null && SELF_AUTHENTICATING_HOSTS.has(host);
}

/**
 * May we attach the user's id token when fetching this URL?
 *
 * Only for our own origin and our own API host. A stored `downloadUrl` is data:
 * it comes out of a document, and a document can be wrong, migrated from
 * elsewhere, or written by a path nobody audited today. None of that should be
 * able to aim a live bearer token at an arbitrary host, so the allow-list is
 * passed in by the caller rather than inferred from the URL.
 *
 * A root-relative URL is same-origin by definition and always allowed.
 */
export function isCredentialTarget(url: string, allowedHosts: readonly string[]): boolean {
  if (isRootRelative(url)) return true;
  const host = hostOf(url);
  if (host === null) return false;
  if (host === RELATIVE_HOST) return true; // parsed against the base, so relative
  return allowedHosts.some((allowed) => allowed.toLowerCase() === host);
}

/**
 * Drop a stale `?token=` before re-requesting with a live Authorization header.
 * Leaving it on makes the host verify an expired credential and answer 401
 * rather than fall through to the header.
 *
 * Returns the input untouched when there is no token, so a URL that needs no
 * repair is never reserialised. Relativeness is decided from the input rather
 * than by comparing the serialised output against `RELATIVE_BASE`, which was the
 * third thing CodeQL flagged: `http://relative.invalid.evil.example/x` shares
 * that prefix and would have been mangled into a different URL.
 */
export function stripStaleToken(url: string): string {
  const relative = isRootRelative(url);
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    if (!parsed.searchParams.has("token")) return url;
    parsed.searchParams.delete("token");
    return relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Best-effort filename for a programmatic save, used when the anchor carries no
 * `download` attribute. The stored path's last segment is the uploaded name,
 * per-segment encoded by the shim, so it needs decoding.
 */
export function fileNameFromStoredUrl(url: string): string {
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "download";
  } catch {
    return "download";
  }
}

/**
 * Hosts the id token may be sent to, from the browser's point of view: this
 * origin, plus the configured self-host API origin (which is a different origin
 * in the split-hostname deployment). Not pure, and not covered by the shim
 * suite, which is why it is the only function here that touches globals.
 */
export function browserCredentialHosts(): string[] {
  const hosts: string[] = [];
  if (typeof window !== "undefined" && window.location?.hostname) {
    hosts.push(window.location.hostname.toLowerCase());
  }
  const apiUrl = process.env.NEXT_PUBLIC_FIBUKI_API_URL;
  if (apiUrl) {
    try {
      hosts.push(new URL(apiUrl).hostname.toLowerCase());
    } catch {
      // A malformed env value must not take down every download in the app.
    }
  }
  return hosts;
}
