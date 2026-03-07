import { doc, getDoc, setDoc, updateDoc, Timestamp } from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  OnboardingState,
  OnboardingStep,
  ONBOARDING_STEPS,
  getStepIndex,
  getNextStep,
  getNextStepForTrack,
  getStepsForTrack,
} from "@/types/onboarding";

const SETTINGS_COLLECTION = "settings";
const ONBOARDING_DOC = "onboarding";

/**
 * Get onboarding state for the current user
 */
export async function getOnboardingState(
  ctx: OperationsContext
): Promise<OnboardingState | null> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  return snapshot.data() as OnboardingState;
}

/**
 * Initialize onboarding for a new user
 */
export async function initializeOnboarding(
  ctx: OperationsContext
): Promise<OnboardingState> {
  const now = Timestamp.now();

  const initialState: OnboardingState = {
    isComplete: false,
    currentStep: "set_identity",
    completedSteps: {},
    startedAt: now,
    completedAt: null,
    hasSeenCompletion: false,
  };

  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );
  await setDoc(docRef, initialState);

  return initialState;
}

/**
 * Mark a step as complete and advance to next step
 */
export async function completeOnboardingStep(
  ctx: OperationsContext,
  step: OnboardingStep,
  entityId?: string
): Promise<void> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );
  const now = Timestamp.now();

  // Get current state
  const current = await getOnboardingState(ctx);
  if (!current) return;

  // Don't re-complete steps
  if (current.completedSteps[step]) return;

  // Find next step (track-aware)
  const nextStep = getNextStepForTrack(step, current.track);
  const isLastStep = !nextStep;

  // Build update object
  const updates: Record<string, unknown> = {
    [`completedSteps.${step}`]: {
      completedAt: now,
      ...(entityId && { entityId }),
    },
  };

  if (isLastStep) {
    updates.isComplete = true;
    updates.completedAt = now;
    // Only reset hasSeenCompletion if this is the first time completing
    // (user hasn't already dismissed the completion dialog)
    const current_hasSeenCompletion = current.hasSeenCompletion;
    if (current_hasSeenCompletion !== true) {
      updates.hasSeenCompletion = false;
    }
  } else {
    updates.currentStep = nextStep;
  }

  await updateDoc(docRef, updates);
}

/**
 * Uncomplete a step (when its conditions are no longer met)
 * This resets the step and all subsequent steps
 */
export async function uncompleteOnboardingStep(
  ctx: OperationsContext,
  step: OnboardingStep
): Promise<void> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );

  // Get current state
  const current = await getOnboardingState(ctx);
  if (!current) return;

  // Don't uncomplete if already not completed
  if (!current.completedSteps[step]) return;

  // Get step index to determine which subsequent steps to also uncomplete
  const stepIndex = getStepIndex(step);

  // Build new completedSteps object, removing this step and all subsequent steps
  const newCompletedSteps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current.completedSteps)) {
    const keyIndex = getStepIndex(key as OnboardingStep);
    if (keyIndex < stepIndex) {
      newCompletedSteps[key] = value;
    }
  }

  // Update state
  await setDoc(docRef, {
    ...current,
    isComplete: false,
    currentStep: step,
    completedSteps: newCompletedSteps,
    completedAt: null,
    hasSeenCompletion: current.hasSeenCompletion ?? false,
  });
}

/**
 * Mark onboarding completion as seen (dismiss celebration)
 */
export async function markOnboardingCompletionSeen(
  ctx: OperationsContext
): Promise<void> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );
  await updateDoc(docRef, { hasSeenCompletion: true });
}

/**
 * Skip the entire onboarding (marks all remaining steps as complete)
 */
export async function skipOnboarding(
  ctx: OperationsContext
): Promise<void> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );
  const now = Timestamp.now();

  const current = await getOnboardingState(ctx);
  if (!current) return;

  // Mark all uncompleted steps as completed (track-aware)
  const trackSteps = getStepsForTrack(current.track);
  const completedSteps = { ...current.completedSteps };
  for (const step of trackSteps) {
    if (!completedSteps[step.id]) {
      completedSteps[step.id] = { completedAt: now };
    }
  }

  await setDoc(docRef, {
    ...current,
    isComplete: true,
    completedSteps,
    completedAt: now,
    skippedAt: now,
    hasSeenCompletion: true, // Don't show celebration for skipped onboarding
  });
}

/**
 * Skip a single onboarding step (advances to next step)
 */
export async function skipOnboardingStep(
  ctx: OperationsContext,
  step: OnboardingStep
): Promise<void> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );
  const now = Timestamp.now();

  const current = await getOnboardingState(ctx);
  if (!current) return;

  // Don't skip already completed steps
  if (current.completedSteps[step]) return;

  const nextStep = getNextStepForTrack(step, current.track);
  const isLastStep = !nextStep;

  const updates: Record<string, unknown> = {
    [`completedSteps.${step}`]: {
      completedAt: now,
    },
    [`skippedSteps.${step}`]: {
      skippedAt: now,
    },
  };

  if (isLastStep) {
    updates.isComplete = true;
    updates.completedAt = now;
    if (current.hasSeenCompletion !== true) {
      updates.hasSeenCompletion = false;
    }
  } else {
    updates.currentStep = nextStep;
  }

  await updateDoc(docRef, updates);
}

/**
 * Reset onboarding state (for testing/debugging)
 */
export async function resetOnboarding(ctx: OperationsContext): Promise<void> {
  const docRef = doc(
    ctx.db,
    "users",
    ctx.userId,
    SETTINGS_COLLECTION,
    ONBOARDING_DOC
  );

  // Delete the document to reset
  const { deleteDoc } = await import("firebase/firestore");
  await deleteDoc(docRef);
}

/**
 * Check if user has completed onboarding
 */
export async function isOnboardingComplete(
  ctx: OperationsContext
): Promise<boolean> {
  const state = await getOnboardingState(ctx);
  return state?.isComplete ?? false;
}

/**
 * Get progress information
 */
export function calculateProgress(state: OnboardingState | null): {
  completed: number;
  total: number;
  percentage: number;
} {
  const trackSteps = getStepsForTrack(state?.track);
  if (!state) {
    return { completed: 0, total: trackSteps.length, percentage: 0 };
  }

  const completed = trackSteps.filter(
    (s) => !!state.completedSteps[s.id]
  ).length;
  return {
    completed,
    total: trackSteps.length,
    percentage: Math.round((completed / trackSteps.length) * 100),
  };
}
