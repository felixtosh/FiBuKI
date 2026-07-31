/**
 * Tenant identity (docs/rewrite-goals.md §The one architectural idea):
 * self-host is multi-tenant with exactly one tenant. Every table carries
 * tenant_id, every query runs inside a transaction with
 * set_config('app.tenant_id', ..., true), and RLS policies backstop it.
 * There is no if(selfHosted) branch — the selfhost deployment simply never
 * configures a second tenant.
 */

/** The one tenant a selfhost deployment has, unless FIBUKI_TENANT_ID says otherwise. */
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";

export function getTenantId(): string {
  return process.env.FIBUKI_TENANT_ID || DEFAULT_TENANT_ID;
}
