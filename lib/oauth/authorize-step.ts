/**
 * What the authorize page shows, decided from facts. The page itself is plumbing; every
 * "signed in or not" and "which account" rule is here so it can be tested without a browser.
 *
 * The order is the user's journey: be sure the request is valid, be signed in (as the
 * account the app suggested, unless the user chose otherwise), have an identity, consent.
 */

export type RequestState = "loading" | "valid" | "invalid";

export interface AuthorizeFacts {
  request: RequestState;
  /** Auth is still resolving whether anyone is signed in. */
  authLoading: boolean;
  signedIn: boolean;
  /** Signed in, but a second factor is still to be completed. Not signed in yet for our purposes. */
  mfaPending: boolean;
  /** The signed-in account's email. */
  email: string | null;
  /** The email the app suggested (login_hint), if any. */
  hint: string | null;
  /** The user confirmed they want to continue as the signed-in account despite the hint. */
  accountConfirmed: boolean;
  identityLoading: boolean;
  hasIdentity: boolean;
}

export type AuthorizeStep =
  | { step: "loading" }
  | { step: "invalid" }
  | { step: "sign-in" }
  | { step: "account-choice"; current: string; suggested: string }
  | { step: "identity" }
  | { step: "consent" };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function decideAuthorizeStep(f: AuthorizeFacts): AuthorizeStep {
  if (f.request === "loading" || f.authLoading) return { step: "loading" };
  if (f.request === "invalid") return { step: "invalid" };

  // Signed out, or halfway through a second factor: sign-in does both.
  if (!f.signedIn || f.mfaPending) return { step: "sign-in" };

  // A different account than the app suggested: ask, never silently pick. The hint is a
  // suggestion, not proof of who the user is.
  if (f.hint && f.email && !same(f.hint, f.email) && !f.accountConfirmed) {
    return { step: "account-choice", current: f.email, suggested: f.hint };
  }

  if (f.identityLoading) return { step: "loading" };
  if (!f.hasIdentity) return { step: "identity" };
  return { step: "consent" };
}

/** The same authorize request, as a path the sign-in pages can send the user back to. */
export function authorizeReturnPath(search: string): string {
  const query = search.startsWith("?") ? search : `?${search}`;
  return `/oauth/authorize${query === "?" ? "" : query}`;
}

/** Sign-in (or sign-up) page URL that returns here afterwards, with the suggested email filled in. */
export function signInUrl(returnPath: string, hint: string | null, page: "login" | "register" = "login"): string {
  const params = new URLSearchParams({ redirect: returnPath });
  if (hint && page === "login") params.set("email", hint);
  return `/${page}?${params.toString()}`;
}
