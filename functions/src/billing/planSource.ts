/**
 * Where the effective plan comes from, besides the subscription document.
 *
 * This is the Firebase-build implementation: there is no env lever, the
 * stored subscription plan is always authoritative, so the override is
 * always null.
 *
 * The self-host build swaps this module for
 * `selfhost/plan-source-shim.ts` (path-suffix alias in
 * functions/vitest.selfhost.config.ts, the same seam as utils/mailer),
 * where FIBUKI_PLAN - defaulting to the full plan - decides the plan on the
 * selfhost tier. Decision on #159 (Felix, 2026-09-27): no billing code is
 * compiled out; the env var is only a lever.
 */

import type { PlanId } from "./config";

/** The plan the environment dictates, or null when the stored plan rules. */
export function envPlanOverride(): PlanId | null {
  return null;
}
