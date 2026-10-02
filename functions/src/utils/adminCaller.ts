/**
 * Whether a callable's caller is an admin, decided only from the verified
 * token: the `admin` custom claim, or the configured super-admin email.
 *
 * Never from a document. users/{uid} is the caller's own document on the
 * client data plane, so a flag read from it is one the caller sets for
 * themselves.
 *
 * The super-admin match requires SUPER_ADMIN_EMAIL to be set: comparing an
 * unset variable against a token with no email is undefined === undefined.
 */
export function isAdminCaller(auth: { token?: Record<string, unknown> } | undefined | null): boolean {
  const token = auth?.token;
  if (!token) return false;
  if (token.admin === true) return true;
  const superAdmin = process.env.SUPER_ADMIN_EMAIL;
  return !!superAdmin && typeof token.email === "string" && token.email === superAdmin;
}
