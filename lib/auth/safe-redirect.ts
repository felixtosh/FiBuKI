/**
 * Where to send the browser after signing in or up, from a `redirect` query parameter.
 *
 * Only a path on this site is acceptable. "//evil.example" and "/\evil.example" start with a
 * slash too but are read by browsers as another host, so a bare startsWith("/") check is an
 * open redirect.
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/transactions"): string {
  if (!value || !value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // A control character can hide a second slash from the check above ("/\t/evil.example").
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  return value;
}

/** The login and register pages take the email a connecting app suggested as `email`. */
export function hintedEmail(value: string | null | undefined): string {
  const email = (value ?? "").trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : "";
}
