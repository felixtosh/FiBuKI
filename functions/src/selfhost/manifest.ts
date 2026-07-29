/**
 * Selfhost build manifest: which index.ts barrel exports the HTTP host
 * must NOT mount. Everything not listed here is served.
 *
 * Exclusion classes (see port-architecture.md §3 and the triage table in
 * the project folder's callable-triage.md):
 *
 * - billing/expand:  Stripe-backed SaaS billing and country-expansion
 *   crowdfunding. Excluded from the selfhost build by design; quota checks
 *   inside handlers stay (they read Firestore, no Stripe).
 * - mfa/registration: passkeys, TOTP, backup codes, invite-only
 *   registration, password reset. Identity is Authentik's job in the
 *   selfhost deployment (OIDC in front of the host).
 * - admin multi-user: user management and impersonation for the hosted
 *   multi-tenant product. Meaningless single-user.
 * - migration: Firebase-project-to-Firebase-project data migration.
 * - referral: hosted-product growth mechanics.
 */

export const EXCLUDED_EXPORTS: ReadonlySet<string> = new Set([
  // billing (Stripe)
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
  // country expansion (Stripe crowdfunding)
  "backCountry",
  "activateCountry",
  "refundCountryBackers",
  "seedCountryExpansion",
  // MFA / passkeys / TOTP (Authentik owns identity)
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
  "setUserPassword",
  // invite-only registration / seat management / password reset
  "validateRegistration",
  "markInviteUsed",
  "submitAccessRequest",
  "approveAccessRequest",
  "dismissAccessRequest",
  "setOpenSeats",
  "sendInviteNotification",
  "sendPasswordReset",
  "setAdminClaim",
  "listAdmins",
  // hosted-product data migration
  "migrateUserData",
  "checkMigrationStatus",
  // multi-tenant admin surface
  "impersonateUser",
  "listAllUsers",
  "setUserOverride",
  "switchTesterPlan",
  "adminDeleteUser",
  // referral growth mechanics
  "getReferralCode",
  "applyReferralCode",
  "getReferralStats",
]);
