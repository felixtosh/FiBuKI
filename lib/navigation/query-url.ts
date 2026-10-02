/**
 * Change the current page's query string without a Next.js navigation.
 *
 * List pages keep their state in the URL (the selected row, filters, search,
 * an open overlay) so it survives reloads, deep links and the back button.
 * Changing it with router.push/replace is a soft navigation, and on an App
 * Router page that is a server round trip (an `_rsc` request) before React
 * renders the new state. Selecting a row waited on it: the highlight, the URL
 * and the detail panel all appeared together, a server hop after the click.
 *
 * The browser's own history API does not navigate. Next.js (14.1+) syncs
 * pushState/replaceState into useSearchParams, so the page re-renders from
 * the new query immediately, and pushState still adds a history entry, so
 * the back button behaves exactly as before.
 *
 * Only for a URL on the current path. Anything else is a real page change and
 * goes through the router, so a caller never has to know which it is.
 */

type QueryRouter = {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
};

function samePath(url: string): boolean {
  if (typeof window === "undefined") return false;
  return new URL(url, window.location.href).pathname === window.location.pathname;
}

/** A new history entry: back returns to the previous query. */
export function pushQuery(router: QueryRouter, url: string): void {
  if (samePath(url)) window.history.pushState(null, "", url);
  else router.push(url, { scroll: false });
}

/** Rewrite the current entry: for state the back button should skip (typing, restores). */
export function replaceQuery(router: QueryRouter, url: string): void {
  if (samePath(url)) window.history.replaceState(null, "", url);
  else router.replace(url, { scroll: false });
}
