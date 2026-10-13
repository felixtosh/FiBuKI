/**
 * First-touch signup attribution capture (GTM Phase 1).
 *
 * Mirrors the referral-code persistence in the auth pages: the UTM parameters,
 * the document referrer and the landing pathname are read when an auth page
 * mounts and stashed in localStorage so they survive the OAuth round-trip, then
 * flushed to the `recordSignupAttribution` callable once the user resolves
 * post-signup and the key is cleared.
 *
 * First-touch: once a value is stored it is never overwritten, so the campaign a
 * visitor arrived on is the one recorded, not whichever page they happened to be
 * on when they finally signed up.
 */

export const ATTRIBUTION_STORAGE_KEY = "fibuki_attribution";

/** Shape stored in localStorage and sent to `recordSignupAttribution`. */
export interface SignupAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
  landingPath: string | null;
}

/** Accepts both URLSearchParams and Next's ReadonlyURLSearchParams. */
type ParamReader = { get(name: string): string | null };

function nullableParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Capture first-touch attribution from the current URL into localStorage. No-op
 * on the server, and no-op if attribution was already stored (first-touch).
 */
export function captureSignupAttribution(searchParams: ParamReader): void {
  if (typeof window === "undefined") return;
  // First-touch: never overwrite a value already captured in this browser.
  if (localStorage.getItem(ATTRIBUTION_STORAGE_KEY)) return;

  const attribution: SignupAttribution = {
    utmSource: nullableParam(searchParams.get("utm_source")),
    utmMedium: nullableParam(searchParams.get("utm_medium")),
    utmCampaign: nullableParam(searchParams.get("utm_campaign")),
    utmTerm: nullableParam(searchParams.get("utm_term")),
    utmContent: nullableParam(searchParams.get("utm_content")),
    referrer: nullableParam(document.referrer),
    landingPath: nullableParam(window.location.pathname),
  };

  try {
    localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
  } catch {
    // Private-mode / quota errors: attribution is best-effort, never block signup.
  }
}

/** Read stored attribution, or null if none / unparseable. */
export function readSignupAttribution(): SignupAttribution | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SignupAttribution;
  } catch {
    return null;
  }
}

export function clearSignupAttribution(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
}
