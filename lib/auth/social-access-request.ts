/**
 * Detect a non-invited social sign-in bounced back to the login / register
 * page, so the shared UI can show the same "access request submitted" banner
 * for both builds.
 *
 * Firebase build: the outcome comes from the auth provider's
 * `processOAuthResult` (validateRegistration → submitAccessRequest →
 * `accessRequested`), and this marker never appears — the helper is a no-op.
 *
 * Self-host build: the invite gate blocks the account server-side and the auth
 * client's `errorCallbackURL` returns here with `fibuki_social_error` on the
 * URL (the host has already recorded the access request in its create hook).
 * The page calls this on mount to surface the banner.
 */

const SOCIAL_ERROR_PARAM = "fibuki_social_error";

/**
 * True once if the current URL carries the social-error marker, which it then
 * strips (so a reload doesn't re-show the banner and the query stays clean).
 * Other query params are preserved. Safe to call during SSR (returns false).
 */
export function consumeSocialAccessRequest(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has(SOCIAL_ERROR_PARAM)) return false;
  params.delete(SOCIAL_ERROR_PARAM);
  // Better Auth appends its own ?error=/&error_description= to our
  // errorCallbackURL (see redirectOnError). We already surface the outcome as
  // the banner, so clear those too rather than leave a confusing "error=…" in
  // the user's URL bar. Safe to strip unconditionally here — we only reach
  // this point on our own marked error return.
  params.delete("error");
  params.delete("error_description");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
  return true;
}
