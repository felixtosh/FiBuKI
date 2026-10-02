/**
 * Onboarding state: read the user's facts, keep users/{uid}/settings/onboarding in step
 * with them, and answer "where is this user?" for every surface (web app, MCP tools).
 *
 * The document shape is the one the web app has always read (types/onboarding.ts), so
 * the browser listener keeps working unchanged. Every write goes through here.
 */

import { Timestamp, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  deriveCompletions,
  isOnboardingOrigin,
  ONBOARDING_STEP_IDS,
  type OnboardingFacts,
  type OnboardingOrigin,
  type OnboardingStepId,
} from "./onboardingRules";

/** Transactions scanned for the partner and document steps. Enough for any account that has started matching. */
const TRANSACTION_SCAN_LIMIT = 500;

/** The trial every new user starts: everyone is full service. */
export const DEFAULT_TRIAL_TIER = "smart";

type StepRecord = { completedAt: Timestamp; entityId?: string };

export interface OnboardingDoc {
  isComplete: boolean;
  currentStep: OnboardingStepId;
  completedSteps: Partial<Record<OnboardingStepId, StepRecord>>;
  skippedSteps?: Partial<Record<OnboardingStepId, { skippedAt: Timestamp }>>;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  hasSeenCompletion: boolean;
  skippedAt?: Timestamp | null;
  /** Where the user signed up from. Set once. */
  origin?: OnboardingOrigin;
  /** The welcome screen was shown and acknowledged. */
  welcomeSeen?: boolean;
  /** Legacy: the removed two-track choice. Read only, to retire "data_only" users. */
  track?: "data_only" | "full_service";
  updatedAt?: unknown;
}

function onboardingRef(db: Firestore, userId: string) {
  return db.doc(`users/${userId}/settings/onboarding`);
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export function hasIdentityIn(userData: Record<string, unknown> | undefined): boolean {
  if (!userData) return false;
  const personal = userData.personalEntity as { name?: string } | undefined;
  const companies = userData.companies as unknown[] | undefined;
  if (personal?.name || (companies?.length ?? 0) > 0) return true;
  // Legacy format
  return !!(userData.name || userData.companyName);
}

export async function loadFacts(db: Firestore, userId: string): Promise<OnboardingFacts> {
  const [userDataSnap, gmailSnap, sourceSnap, txSnap] = await Promise.all([
    db.doc(`users/${userId}/settings/userData`).get(),
    db
      .collection("emailIntegrations")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .where("provider", "==", "gmail")
      .limit(1)
      .get(),
    db.collection("sources").where("userId", "==", userId).where("isActive", "==", true).limit(1).get(),
    db.collection("transactions").where("userId", "==", userId).limit(TRANSACTION_SCAN_LIMIT).get(),
  ]);

  let partnerTransactionId: string | null = null;
  let documentedTransactionId: string | null = null;
  for (const doc of txSnap.docs) {
    const t = doc.data();
    if (!partnerTransactionId && t.partnerId) partnerTransactionId = doc.id;
    const fileIds = t.fileIds as unknown[] | undefined;
    if (!documentedTransactionId && ((fileIds && fileIds.length > 0) || t.noReceiptCategoryId)) {
      documentedTransactionId = doc.id;
    }
  }

  return {
    hasIdentity: hasIdentityIn(userDataSnap.exists ? (userDataSnap.data() as Record<string, unknown>) : undefined),
    hasGmailIntegration: !gmailSnap.empty,
    firstSourceId: sourceSnap.empty ? null : sourceSnap.docs[0].id,
    hasTransactions: !txSnap.empty,
    partnerTransactionId,
    documentedTransactionId,
  };
}

// ---------------------------------------------------------------------------
// Pure state transitions (no I/O)
// ---------------------------------------------------------------------------

function completedSet(state: OnboardingDoc): Set<OnboardingStepId> {
  return new Set(
    ONBOARDING_STEP_IDS.filter((id) => !!state.completedSteps?.[id])
  );
}

function skippedSet(state: OnboardingDoc): Set<OnboardingStepId> {
  return new Set(ONBOARDING_STEP_IDS.filter((id) => !!state.skippedSteps?.[id]));
}

/**
 * Mark `step` complete. The current step becomes the first one still open, which is
 * the next one in the usual case but not when a later step was skipped first; when
 * none is open, onboarding is finished.
 */
export function withStepCompleted(
  state: OnboardingDoc,
  step: OnboardingStepId,
  now: Timestamp,
  opts: { entityId?: string; skipped?: boolean } = {}
): OnboardingDoc {
  if (state.completedSteps?.[step]) return state;

  const next: OnboardingDoc = {
    ...state,
    completedSteps: {
      ...state.completedSteps,
      [step]: { completedAt: now, ...(opts.entityId ? { entityId: opts.entityId } : {}) },
    },
  };
  if (opts.skipped) next.skippedSteps = { ...state.skippedSteps, [step]: { skippedAt: now } };

  const stillOpen = ONBOARDING_STEP_IDS.find((id) => !next.completedSteps[id]);
  if (stillOpen) {
    next.currentStep = stillOpen;
  } else {
    next.isComplete = true;
    next.completedAt = now;
    // Do not bring the celebration back for someone who already dismissed it.
    if (state.hasSeenCompletion !== true) next.hasSeenCompletion = false;
  }
  return next;
}

/** The steps the facts complete, applied in order. */
export function applyFacts(state: OnboardingDoc, facts: OnboardingFacts, now: Timestamp): OnboardingDoc {
  let next = state;
  for (const { step, entityId } of deriveCompletions(completedSet(state), skippedSet(state), facts)) {
    next = withStepCompleted(next, step, now, { entityId });
  }
  return next;
}

export function withEverythingSkipped(state: OnboardingDoc, now: Timestamp): OnboardingDoc {
  const completedSteps = { ...state.completedSteps };
  for (const id of ONBOARDING_STEP_IDS) {
    if (!completedSteps[id]) completedSteps[id] = { completedAt: now };
  }
  return {
    ...state,
    isComplete: true,
    completedSteps,
    completedAt: now,
    skippedAt: now,
    hasSeenCompletion: true, // no celebration for a skipped onboarding
  };
}

export function newOnboardingDoc(now: Timestamp, origin: OnboardingOrigin): OnboardingDoc {
  return {
    isComplete: false,
    currentStep: ONBOARDING_STEP_IDS[0],
    completedSteps: {},
    startedAt: now,
    completedAt: null,
    hasSeenCompletion: false,
    welcomeSeen: false,
    origin,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function startTrialIfNew(db: Firestore, userId: string): Promise<void> {
  const subRef = db.collection("subscriptions").doc(userId);
  const sub = await subRef.get();
  if (!sub.exists) return;
  const data = sub.data()!;
  // Not for someone whose trial already started, and not for a paying customer.
  if (data.trialStartedAt || data.stripeSubscriptionId) return;
  await subRef.update({
    trialTier: DEFAULT_TRIAL_TIER,
    trialStartedAt: FieldValue.serverTimestamp(),
    trialTransactionCount: 0,
    trialExpired: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Create the onboarding document if there is none (and start the trial with it).
 * Idempotent: a second call, or a second tab, changes nothing. `origin` is only
 * recorded by the call that creates the document.
 */
export async function ensureOnboarding(
  db: Firestore,
  userId: string,
  origin: OnboardingOrigin = "web"
): Promise<{ state: OnboardingDoc; created: boolean }> {
  const ref = onboardingRef(db, userId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { state: snap.data() as OnboardingDoc, created: false };
    const state = newOnboardingDoc(Timestamp.now(), isOnboardingOrigin(origin) ? origin : "web");
    tx.set(ref, state);
    return { state, created: true };
  });
  if (result.created) await startTrialIfNew(db, userId);
  return result;
}

/** Read-modify-write the document in one transaction. */
async function mutate(
  db: Firestore,
  userId: string,
  change: (state: OnboardingDoc) => OnboardingDoc
): Promise<OnboardingDoc> {
  const ref = onboardingRef(db, userId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Onboarding has not been started");
    const before = snap.data() as OnboardingDoc;
    const after = change(before);
    if (after !== before) tx.set(ref, { ...after, updatedAt: FieldValue.serverTimestamp() });
    return after;
  });
}

/**
 * Bring the document in line with the user's data, starting onboarding if needed.
 * Safe to call as often as you like. Once onboarding is complete (or skipped) it is a
 * no-op: completed onboarding never reopens because of later data.
 */
export async function syncOnboarding(
  db: Firestore,
  userId: string,
  origin?: OnboardingOrigin
): Promise<OnboardingDoc> {
  const { state } = await ensureOnboarding(db, userId, origin);
  const now = Timestamp.now();

  // The removed "bank data only" track had its own short flow. Those users keep
  // working: their onboarding is retired rather than reopened with six steps.
  if (state.track === "data_only" && !state.isComplete) {
    return mutate(db, userId, (s) => (s.isComplete ? s : withEverythingSkipped(s, now)));
  }
  if (state.isComplete) return state;

  const facts = await loadFacts(db, userId);
  return mutate(db, userId, (s) => (s.isComplete ? s : applyFacts(s, facts, now)));
}

export type OnboardingAction =
  | { action: "skip_step"; step: OnboardingStepId }
  | { action: "skip_all" }
  | { action: "completion_seen" }
  | { action: "welcome_seen" };

export async function updateOnboarding(
  db: Firestore,
  userId: string,
  request: OnboardingAction
): Promise<OnboardingDoc> {
  await ensureOnboarding(db, userId);
  const now = Timestamp.now();
  return mutate(db, userId, (s) => {
    switch (request.action) {
      case "skip_step":
        return withStepCompleted(s, request.step, now, { skipped: true });
      case "skip_all":
        return withEverythingSkipped(s, now);
      case "completion_seen":
        return s.hasSeenCompletion === true ? s : { ...s, hasSeenCompletion: true };
      case "welcome_seen":
        return s.welcomeSeen === true ? s : { ...s, welcomeSeen: true };
    }
  });
}

// ---------------------------------------------------------------------------
// What the tools and callers see
// ---------------------------------------------------------------------------

/** Where each step is done on fibuki.com. */
const STEP_ROUTES: Record<OnboardingStepId, string> = {
  set_identity: "/settings/identity",
  connect_email: "/integrations/gmail",
  add_bank_account: "/sources",
  import_transactions: "/sources",
  assign_partner: "/transactions",
  attach_file: "/transactions",
};

const STEP_TITLES: Record<OnboardingStepId, string> = {
  set_identity: "Tell FiBuKI who you are",
  connect_email: "Connect your mailbox",
  add_bank_account: "Add a bank account",
  import_transactions: "Import transactions",
  assign_partner: "Assign a partner",
  attach_file: "Attach a receipt or mark a category",
};

export interface OnboardingStatus {
  complete: boolean;
  origin: OnboardingOrigin;
  welcomeSeen: boolean;
  currentStep: OnboardingStepId | null;
  progress: { done: number; total: number };
  steps: Array<{
    id: OnboardingStepId;
    title: string;
    state: "done" | "skipped" | "open";
    /** Path on fibuki.com where the user does this step. */
    route: string;
  }>;
}

export function toStatus(state: OnboardingDoc): OnboardingStatus {
  const skipped = skippedSet(state);
  const done = completedSet(state);
  const steps = ONBOARDING_STEP_IDS.map((id) => ({
    id,
    title: STEP_TITLES[id],
    state: (skipped.has(id) ? "skipped" : done.has(id) ? "done" : "open") as "done" | "skipped" | "open",
    route: STEP_ROUTES[id],
  }));
  return {
    complete: state.isComplete,
    origin: isOnboardingOrigin(state.origin) ? state.origin : "web",
    welcomeSeen: state.welcomeSeen === true || !!state.track,
    currentStep: state.isComplete ? null : state.currentStep,
    progress: { done: steps.filter((s) => s.state !== "open").length, total: steps.length },
    steps,
  };
}
