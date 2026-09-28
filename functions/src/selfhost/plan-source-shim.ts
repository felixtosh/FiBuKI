/**
 * Selfhost drop-in for `billing/planSource` (aliased by path suffix in
 * vitest.selfhost.config.ts): on the selfhost tier the plan is an env
 * lever, not a Stripe subscription.
 *
 * Decision on #159 (Felix, 2026-09-27):
 *
 *   FIBUKI_PLAN=<free|data|smart|pro|full>   default: full (= pro)
 *
 * A self-hoster has nobody to bill, so the default is the full feature
 * surface — "self-host and cloud ship the same features" (docs/who-is-this-
 * for.md). No billing code is compiled out; the env var only decides which
 * plan every account on the box resolves to.
 *
 * Tier-aware on purpose: FIBUKI_TIER=cloud (the hosted fibuki.com) ignores
 * FIBUKI_PLAN entirely — there, Stripe owns the plan and this returns null,
 * the same answer as the Firebase-build module this file replaces.
 */

import type { PlanId } from "../billing/config";
import { activeTier } from "./manifest";

/** The id "full" maps to: the plan with every feature. */
const FULL_PLAN: PlanId = "pro";

const SETTABLE: ReadonlySet<string> = new Set(["free", "data", "smart", "pro"]);

/** The plan the environment dictates, or null when the stored plan rules. */
export function envPlanOverride(): PlanId | null {
  if (activeTier() !== "selfhost") return null;

  const raw = process.env.FIBUKI_PLAN?.trim().toLowerCase();
  if (!raw || raw === "full") return FULL_PLAN;
  if (SETTABLE.has(raw)) return raw as PlanId;

  // A typo like FIBUKI_PLAN=fre must not silently grant the full plan —
  // the operator set the lever on purpose, so a bad value is a hard error.
  throw new Error(
    `FIBUKI_PLAN="${raw}" is not a plan — use one of full, free, data, smart, pro (unset = full)`,
  );
}
