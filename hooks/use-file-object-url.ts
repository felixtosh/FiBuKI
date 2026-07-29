"use client";

import { useEffect, useState } from "react";
import { auth } from "@/lib/firebase/config";

/**
 * Turn a stored file `downloadUrl` into something a browser can actually render.
 *
 * ## Why this exists
 *
 * Firebase Storage URLs are *self-authenticating* — the stored string carries its
 * own `?token=` download token, so `<iframe src={file.downloadUrl}>` just works.
 * The self-host blob plane is not: `/__storage/download/<path>` requires an
 * Authorization header (or a token in the query string), so feeding the stored URL
 * straight to an iframe returns 401. Every viewer in the app read the stored field
 * directly, which meant they were quietly load-bearing on a Firebase-specific
 * property.
 *
 * This hook fetches the object WITH a bearer header and hands back a
 * `blob:` URL, which is usable as an `<iframe>`, `<img>` or `<embed>` src.
 *
 * ## Why not put the token in the URL
 *
 * The client storage shim's `getDownloadURL()` appends `?token=<id-token>` so a URL
 * works as an iframe src, and its own comment scopes that as "fine for a
 * single-user LAN deployment". new.fibuki.com is on the public internet, where a
 * URL-borne credential leaks through `Referer`, proxy logs, browser history and
 * anything the user pastes. A bearer header plus a blob URL keeps the credential
 * out of every one of those.
 *
 * ## Same code locally and in production
 *
 * No build-time branching. A URL that is already self-authenticating (a Firebase
 * URL, or anything carrying an explicit token) is returned untouched, so the
 * Firebase build and any not-yet-migrated document keep working. Only URLs that
 * need a header get fetched. Cross-origin works because the host sends CORS for
 * the configured web origin; same-origin local dev works for the same reason.
 *
 * Trade-off worth knowing: this buffers the whole object before rendering, so it
 * gives up HTTP range requests. Fine for invoices and receipts, wrong for very
 * large files.
 */

/**
 * A URL the browser can load without us attaching credentials.
 *
 * Firebase Storage download tokens are durable — they live on the object until
 * revoked — so those URLs are genuinely self-authenticating and pass through.
 * Local blob:/data: URLs need nothing.
 *
 * A self-host `?token=` URL is deliberately NOT trusted, even though the download
 * route accepts one. Those carried a bearer token, which expires within the hour,
 * so trusting them meant a stored URL silently stopped working and the preview
 * failed with a 401. Re-fetching with a fresh header always works, so any such URL
 * is treated as needing credentials and the stale token is stripped before the
 * request. (getDownloadURL no longer mints these, but migrated and previously
 * stored documents still hold them.)
 */
function isSelfAuthenticating(url: string): boolean {
  return (
    url.includes("firebasestorage.googleapis.com") ||
    url.includes("storage.googleapis.com") ||
    url.startsWith("blob:") ||
    url.startsWith("data:")
  );
}

/**
 * Drop a stale `?token=` before re-requesting with a live Authorization header.
 * Leaving it on would make the host verify an expired credential and 401 rather
 * than fall through to the header.
 */
function stripStaleToken(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    u.searchParams.delete("token");
    return u.toString();
  } catch {
    return url;
  }
}

export interface FileObjectUrl {
  /** Renderable URL, or null while loading / on failure. */
  url: string | null;
  loading: boolean;
  error: string | null;
}

export function useFileObjectUrl(
  downloadUrl: string | null | undefined
): FileObjectUrl {
  const [state, setState] = useState<FileObjectUrl>({
    url: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!downloadUrl) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    if (isSelfAuthenticating(downloadUrl)) {
      setState({ url: downloadUrl, loading: false, error: null });
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, loading: true, error: null });

    void (async () => {
      try {
        const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
        const res = await fetch(stripStaleToken(downloadUrl), {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          throw new Error(
            res.status === 401 || res.status === 403
              ? "Not authorised to view this file."
              : `Could not load the file (${res.status}).`
          );
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          url: null,
          loading: false,
          error: err instanceof Error ? err.message : "Could not load the file.",
        });
      }
    })();

    return () => {
      cancelled = true;
      // Release the blob so a long session paging through files does not
      // accumulate the whole set in memory.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [downloadUrl]);

  return state;
}
