/**
 * Selfhost build manifest: which index.ts barrel exports the HTTP host must NOT
 * mount. Everything not listed is served.
 *
 * ## Why this is tier-aware
 *
 * The original list was written for one deployment shape: a single-user self-host
 * box with Authentik in front and no commercial surface. That assumption stops
 * holding at the W4 cutover, because cloud fibuki.com then runs *this same build*.
 * Excluding Stripe unconditionally would take the paid tiers offline, and
 * excluding the admin surface would remove the tooling for the very
 * multi-tenancy the cloud tier exists to provide.
 *
 * It also contradicted the standing rule in docs/rewrite-goals.md — self-host and
 * cloud ship the SAME features, and the split is effort and infrastructure, never
 * capability. A build-level capability split is exactly what that forbids.
 *
 * So exclusions are grouped by *reason* and composed per tier:
 *
 *   FIBUKI_TIER=selfhost   (default) — today's behaviour, unchanged
 *   FIBUKI_TIER=cloud                — mounts the commercial + admin surface
 *
 * Defaulting to `selfhost` keeps every existing deployment byte-identical; the
 * cloud tier opts in, which is safe because the cutover is a deliberate act with
 * a runbook rather than something that happens by accident.
 */

export type Tier = "selfhost" | "cloud";

/**
 * Stripe-backed SaaS billing. A self-host install has no Stripe account and no
 * plan to sell; the cloud tier's revenue depends on all of it.
 *
 * Note the quota checks *inside* handlers are not affected either way — they read
 * Firestore, not Stripe, so a self-host install still enforces its own limits.
 */
const BILLING = [
  "createCheckoutSession",
  "createPortalSession",
  "addAICredits",
  "updateOverageSettings",
  "switchPlan",
  "stripeWebhook",
  "updateAutomationMode",
  "activateInvestmentsAddon",
  "deactivateInvestmentsAddon",
  "activateBmdExportAddon",
  "deactivateBmdExportAddon",
  "activatePrioritySupportAddon",
  "deactivatePrioritySupportAddon",
  "unsubscribeBudgetWarnings",
] as const;

/** Country-expansion crowdfunding — also Stripe, also cloud-only. */
const COUNTRY_EXPANSION = [
  "backCountry",
  "activateCountry",
  "refundCountryBackers",
  "seedCountryExpansion",
] as const;

/**
 * Identity operations that Better Auth owns outright on the selfhost stack.
 *
 * These are Firebase Auth operations: setting a password, sending a reset,
 * validating an invite at registration. Better Auth exposes its own endpoints for
 * all of it under /__auth, so mounting these would be a second, divergent path to
 * the same state. Excluded on BOTH tiers after the cutover for that reason —
 * not because self-host is single-user.
 */
const IDENTITY_OWNED_BY_AUTH = [
  "setUserPassword",
  "sendPasswordReset",
  "validateRegistration",
  "markInviteUsed",
] as const;

/**
 * Passkeys / TOTP / backup codes.
 *
 * Not yet exercised on the selfhost stack — these are @simplewebauthn plus
 * Firestore reads, so they should port through the shim, but nobody has run them.
 *
 * Mounted on the cloud tier anyway, deliberately. Withholding unverified surface
 * is self-defeating: it cannot be functionally tested while it is unmounted, so it
 * stays unverified indefinitely. Mounting it on a staging tier is how the gap gets
 * found, and finding it there is the entire point of having one.
 *
 * Caveat worth knowing while testing: a half-working passkey path can leave an
 * account with an enrolled credential that will not authenticate. Fine on a box
 * holding a copy of the data; verify before this tier fronts real users.
 */
export const MFA_UNVERIFIED = [
  "generateBackupCodes",
  "verifyBackupCode",
  "getMfaStatus",
  "recordMfaSuccess",
  "adminResetMfa",
  "generatePasskeyRegistrationOptions",
  "verifyPasskeyRegistration",
  "generatePasskeyAuthOptions",
  "verifyPasskeyAuth",
  "deletePasskey",
  "updateTotpStatus",
] as const;

/**
 * Seat and invite administration. Meaningless on a single-user box; required by
 * the cloud tier, which is invite-only.
 */
export const SEATS_AND_INVITES = [
  "submitAccessRequest",
  "approveAccessRequest",
  "dismissAccessRequest",
  "setOpenSeats",
  "sendInviteNotification",
] as const;

/** Multi-tenant admin surface. Cloud needs every one of these. */
export const ADMIN_MULTI_USER = [
  "setAdminClaim",
  "listAdmins",
  "impersonateUser",
  "listAllUsers",
  "setUserOverride",
  "switchTesterPlan",
  "adminDeleteUser",
] as const;

/** Hosted-product growth mechanics. Cloud-only. */
const REFERRAL = [
  "getReferralCode",
  "applyReferralCode",
  "getReferralStats",
] as const;

/**
 * Firebase-project-to-Firebase-project data migration. Dead on both tiers once
 * production no longer runs on Firebase — there is no source project to read.
 */
const HOSTED_MIGRATION = ["migrateUserData", "checkMigrationStatus"] as const;

/**
 * Excluded regardless of tier — kept to the two cases where mounting is not
 * merely unnecessary but actively wrong:
 *
 *  - HOSTED_MIGRATION reads a source Firebase project that will not exist.
 *  - IDENTITY_OWNED_BY_AUTH would create a second, divergent path to state Better
 *    Auth already owns.
 *
 * Everything else is a tier question, not a correctness one. The bias is
 * deliberately toward mounting: unmounted surface cannot be functionally tested.
 */
const ALWAYS_EXCLUDED: readonly string[] = [
  ...HOSTED_MIGRATION,
  ...IDENTITY_OWNED_BY_AUTH,
];

/**
 * Additionally excluded on a self-host install.
 *
 * Only the genuinely commercial surface: a self-hoster has no Stripe account, no
 * country-crowdfunding campaign and no referral programme, so these would be dead
 * endpoints rather than features. MFA, seats and the admin surface are mounted on
 * both tiers — a self-host install is "multi-tenant with one tenant", which still
 * means real users, invites and an admin.
 */
const SELFHOST_ONLY_EXCLUSIONS: readonly string[] = [
  ...BILLING,
  ...COUNTRY_EXPANSION,
  ...REFERRAL,
];

/**
 * Groups that are deliberately NOT excluded on either tier, exported so the
 * choice is assertable rather than implied by absence.
 *
 * These were excluded before this file became tier-aware, on the reasoning that a
 * self-host box is single-user and fronted by Authentik. Neither holds: the stack
 * ships with Better Auth and a self-host install is multi-tenant with one tenant,
 * which still has real users, invites and an admin. Mounting them is also the only
 * way they get functionally tested.
 */
export const MOUNTED_ON_ALL_TIERS: readonly string[] = [
  ...MFA_UNVERIFIED,
  ...SEATS_AND_INVITES,
  ...ADMIN_MULTI_USER,
];

export function activeTier(): Tier {
  const raw = process.env.FIBUKI_TIER?.trim();
  if (!raw) return "selfhost";
  if (raw !== "selfhost" && raw !== "cloud") {
    throw new Error(
      `selfhost manifest: FIBUKI_TIER="${raw}" must be "selfhost" or "cloud"`,
    );
  }
  return raw;
}

export function excludedFor(tier: Tier): ReadonlySet<string> {
  return new Set(
    tier === "cloud"
      ? ALWAYS_EXCLUDED
      : [...ALWAYS_EXCLUDED, ...SELFHOST_ONLY_EXCLUSIONS],
  );
}

/**
 * Resolved exclusions for the tier this process is running as.
 *
 * Evaluated at import, which is how the rest of the selfhost modules read their
 * environment. host.ts consumes this directly, so no call site changes.
 */
export const EXCLUDED_EXPORTS: ReadonlySet<string> = excludedFor(activeTier());
