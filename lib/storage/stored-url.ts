/**
 * Classifying a STORED download URL: can the browser load it on its own, or do
 * we have to attach credentials?
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
 * These two predicates are the shared half of both answers. Pure and free of
 * browser globals on purpose, so the self-host suite can pin them.
 */

/**
 * Parsing base for a root-relative stored URL. `FIBUKI_PUBLIC_URL` is empty in
 * the common single-reverse-proxy deployment, so the shim emits
 * `/__storage/download/…` and these helpers must not choke on it. Never
 * dereferenced; only used to make `new URL` accept a relative path.
 */
const RELATIVE_BASE = "http://relative.invalid";

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
  return (
    url.includes("firebasestorage.googleapis.com") ||
    url.includes("storage.googleapis.com") ||
    url.startsWith("blob:") ||
    url.startsWith("data:")
  );
}

/**
 * Drop a stale `?token=` before re-requesting with a live Authorization header.
 * Leaving it on makes the host verify an expired credential and answer 401
 * rather than fall through to the header.
 *
 * Returns the input untouched when there is no token, so a URL that needs no
 * repair is never reserialised — a relative path stays relative, and the string
 * a caller passes to `fetch` stays the string it wrote.
 */
export function stripStaleToken(url: string): string {
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    if (!parsed.searchParams.has("token")) return url;
    parsed.searchParams.delete("token");
    const out = parsed.toString();
    return out.startsWith(RELATIVE_BASE) ? out.slice(RELATIVE_BASE.length) : out;
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
