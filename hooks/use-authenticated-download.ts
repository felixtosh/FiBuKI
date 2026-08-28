"use client";

import { useCallback, useRef, useState } from "react";
import { auth } from "@/lib/firebase/config";
import {
  browserCredentialHosts,
  fileNameFromStoredUrl,
  isCredentialTarget,
  isSelfAuthenticating,
  stripStaleToken,
} from "@/lib/storage/stored-url";

/**
 * Make an `<a href download>` work when the stored URL needs credentials.
 *
 * The self-host blob plane requires an Authorization header, and a browser
 * navigating to an anchor sends cookies, never a header. The app holds its id
 * token in JavaScript rather than a cookie, so the request genuinely arrives
 * unauthenticated and the storage route refuses it — correctly. That is #206:
 * a BMD export, a user-export archive or an issued invoice PDF was produced and
 * then could not be retrieved.
 *
 * ## Why an interceptor rather than replacing the anchors
 *
 * The handler returns immediately for a self-authenticating URL, so on the
 * Firebase build the anchor navigates exactly as it did before: same href, same
 * `download`, same `target`. Cloud behaviour is unchanged by construction
 * rather than by testing, which is the fourth acceptance criterion of #206.
 * Only a URL that needs a header is intercepted.
 *
 * ## Why not put the token in the URL
 *
 * The download route does accept `?token=`, and using it here would be a
 * one-line fix. It is rejected for the same reason
 * hooks/use-file-object-url.ts rejects it: fibuki.com is on the public
 * internet, where a URL-borne credential leaks through `Referer`, proxy logs,
 * browser history and anything the user pastes. A header plus a blob keeps the
 * credential out of all of those.
 *
 * Trade-off, same as the viewer hook: this buffers the whole object before
 * saving, so it gives up HTTP range requests. Fine for exports, invoices and
 * receipts; wrong for very large objects.
 */
export interface AuthenticatedDownload {
  /** Attach to the existing anchor. Self-authenticating URLs are left alone. */
  onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  /** True while an intercepted download is being fetched. */
  pending: boolean;
  error: string | null;
}

export function useAuthenticatedDownload(): AuthenticatedDownload {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref as well as state: the guard is read inside the click handler, which
  // closes over the state value from the render that produced it.
  const pendingRef = useRef(false);

  const onClick = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    const anchor = event.currentTarget;
    // `href` is the DOM-resolved absolute form, which is what we want to fetch:
    // the shim emits a root-relative URL whenever FIBUKI_PUBLIC_URL is unset.
    const href = anchor.href;
    if (!href || isSelfAuthenticating(href)) return;

    const fileName = anchor.download || fileNameFromStoredUrl(href);
    event.preventDefault();
    // A second click while the first is in flight would buffer the whole object
    // twice and save it twice. The anchor stays enabled on purpose: disabling it
    // would need every call site to render pending state.
    if (pendingRef.current) return;
    pendingRef.current = true;
    setError(null);
    setPending(true);

    void (async () => {
      let objectUrl: string | null = null;
      try {
        // The href comes out of a stored document, so it is data. The token goes
        // to our own origin and our own API host, or the request goes without it.
        const trusted = isCredentialTarget(href, browserCredentialHosts());
        const token = trusted && auth.currentUser ? await auth.currentUser.getIdToken() : null;
        const res = await fetch(stripStaleToken(href), {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          throw new Error(
            res.status === 401 || res.status === 403
              ? "Not authorised to download this file."
              : `Could not download the file (${res.status}).`,
          );
        }
        objectUrl = URL.createObjectURL(await res.blob());
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not download the file.");
      } finally {
        // Revoked on a turn of the event loop, not immediately: Safari reads the
        // blob after click() returns, and revoking synchronously saves nothing.
        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 10_000);
        pendingRef.current = false;
        setPending(false);
      }
    })();
  }, []);

  return { onClick, pending, error };
}
