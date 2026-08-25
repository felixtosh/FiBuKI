/**
 * The origin a *user* can reach this deployment at.
 *
 * Distinct from NEXT_PUBLIC_FUNCTIONS_URL, which is the origin the web container
 * uses to reach the API and is routinely an internal name like
 * http://fibuki-api:8788. That address is useless in an email and misleading in
 * an API spec, so public links come from here instead.
 *
 * Every caller of this used to hardcode
 * `https://europe-west1-taxstudio-f12fb.cloudfunctions.net`, which sent a
 * self-hoster's users to somebody else's backend — an unsubscribe link that
 * quietly acts on the wrong database, or does nothing.
 *
 * Returns null when unset. Link builders refuse rather than emit a wrong address.
 */
export function publicOrigin(): string | null {
  const base = process.env.FIBUKI_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!base) return null;
  return base.replace(/\/$/, "");
}

export const PUBLIC_ORIGIN_UNSET_ERROR =
  "FIBUKI_PUBLIC_URL is not configured, so no user-facing link can be built. " +
  "Set it to the address users reach this deployment at (for example " +
  "https://fibuki.com).";
