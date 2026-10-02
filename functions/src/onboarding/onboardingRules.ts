/**
 * Onboarding rules: which steps exist, in what order, and when each counts as done.
 *
 * Ported from the browser hook (hooks/use-onboarding.ts), which used to decide this on
 * its own. It now lives here so the web app, the MCP tools and any plugin read one answer.
 * Pure: no Firestore, no clock. onboardingState.ts gathers the facts and persists the result.
 *
 * There is one onboarding for everyone. The old two-track choice (full_service / data_only)
 * is gone; the steps below are the former full_service steps.
 */

/** In order. The client's UI config (types/onboarding.ts) must list the same ids; a test pins it. */
export const ONBOARDING_STEP_IDS = [
  "set_identity",
  "connect_email",
  "add_bank_account",
  "import_transactions",
  "assign_partner",
  "attach_file",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** Where a user came from. Recorded once at signup; never decides what a user may do. */
export const ONBOARDING_ORIGINS = ["web", "chatgpt", "codex", "claude", "api"] as const;
export type OnboardingOrigin = (typeof ONBOARDING_ORIGINS)[number];

export function isOnboardingOrigin(value: unknown): value is OnboardingOrigin {
  return typeof value === "string" && (ONBOARDING_ORIGINS as readonly string[]).includes(value);
}

export function isOnboardingStep(value: unknown): value is OnboardingStepId {
  return typeof value === "string" && (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

/** The step after `step`, or null when it was the last. */
export function nextStepAfter(step: OnboardingStepId): OnboardingStepId | null {
  return ONBOARDING_STEP_IDS[ONBOARDING_STEP_IDS.indexOf(step) + 1] ?? null;
}

/** What the user's data says right now. */
export interface OnboardingFacts {
  /** A name on the personal entity, any company, or the legacy name fields. */
  hasIdentity: boolean;
  /** A Gmail Mail Integration. IMAP does not count here, as in the browser hook this was ported from. */
  hasGmailIntegration: boolean;
  /** The first Bank Account, if any. */
  firstSourceId: string | null;
  hasTransactions: boolean;
  /** A Transaction with a Partner. */
  partnerTransactionId: string | null;
  /** A Transaction with a File or a No-document Category. */
  documentedTransactionId: string | null;
}

export interface StepCompletion {
  step: OnboardingStepId;
  /** The record that triggered it, for analytics. */
  entityId?: string;
}

/**
 * The steps the facts now complete, in the order they complete.
 *
 * Steps only ever complete in sequence: a later step stays open until the one before
 * it is done or skipped (a skipped step counts as completed). The email step is not
 * auto-completed once the user skipped it.
 */
export function deriveCompletions(
  completedSteps: ReadonlySet<OnboardingStepId>,
  skippedSteps: ReadonlySet<OnboardingStepId>,
  facts: OnboardingFacts
): StepCompletion[] {
  const done = new Set(completedSteps);
  const out: StepCompletion[] = [];
  const complete = (step: OnboardingStepId, entityId?: string) => {
    done.add(step);
    out.push(entityId ? { step, entityId } : { step });
  };

  if (!done.has("set_identity") && facts.hasIdentity) complete("set_identity");

  if (done.has("set_identity") && !skippedSteps.has("connect_email")) {
    if (!done.has("connect_email") && facts.hasGmailIntegration) complete("connect_email");
  }

  // Nothing past the email step moves until it is done or skipped.
  if (!done.has("connect_email")) return out;

  if (!done.has("add_bank_account") && facts.firstSourceId) {
    complete("add_bank_account", facts.firstSourceId);
  }
  if (done.has("add_bank_account") && !done.has("import_transactions") && facts.hasTransactions) {
    complete("import_transactions");
  }
  if (done.has("import_transactions") && !done.has("assign_partner") && facts.partnerTransactionId) {
    complete("assign_partner", facts.partnerTransactionId);
  }
  if (done.has("assign_partner") && !done.has("attach_file") && facts.documentedTransactionId) {
    complete("attach_file", facts.documentedTransactionId);
  }

  return out;
}
