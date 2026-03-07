"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import {
  OnboardingState,
  OnboardingStep,
  OnboardingStepConfig,
  ONBOARDING_STEPS,
  getStepsForTrack,
  getNextStepForTrack,
  DATA_ONLY_STEPS,
} from "@/types/onboarding";
import {
  OperationsContext,
  initializeOnboarding,
  completeOnboardingStep,
  markOnboardingCompletionSeen,
  calculateProgress,
  skipOnboarding as skipOnboardingOp,
  skipOnboardingStep,
} from "@/lib/operations";
import { useAuth } from "@/components/auth";
import { useSources } from "./use-sources";
import { useTransactions } from "./use-transactions";
import { useUserData } from "./use-user-data";
import { useEmailIntegrations } from "./use-email-integrations";

/**
 * Hook for managing onboarding state and auto-detecting step completion
 */
export function useOnboarding() {
  const { userId } = useAuth();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isServerStateReady, setIsServerStateReady] = useState(false);

  // Dependencies for auto-detection
  const { sources, loading: sourcesLoading } = useSources();
  const { transactions, loading: transactionsLoading } = useTransactions();
  const { userData, loading: userDataLoading, isConfigured: hasIdentity } = useUserData();
  const { hasGmailIntegration, loading: emailLoading } = useEmailIntegrations();

  // Guard against duplicate initialization attempts while awaiting listener updates
  const hasInitializedFromMissingDoc = useRef(false);

  const ctx: OperationsContext = useMemo(
    () => ({
      db,
      userId: userId ?? "",
    }),
    [userId]
  );

  // Real-time listener for onboarding state
  useEffect(() => {
    if (!userId) {
      setState(null);
      setLoading(false);
      setIsServerStateReady(false);
      return;
    }

    setLoading(true);
    setIsServerStateReady(false);
    hasInitializedFromMissingDoc.current = false;

    const docRef = doc(db, "users", userId, "settings", "onboarding");

    const unsubscribe = onSnapshot(
      docRef,
      async (snapshot) => {
        // Wait for server-backed snapshot before running initialization logic.
        if (!snapshot.metadata.fromCache) {
          setIsServerStateReady(true);
        }

        if (snapshot.exists()) {
          const nextState = snapshot.data() as OnboardingState;
          console.log("[Onboarding] Snapshot update:", {
            isComplete: nextState.isComplete,
            hasSeenCompletion: nextState.hasSeenCompletion,
            currentStep: nextState.currentStep,
          });
          setState(nextState);
          setLoading(false);
          return;
        }

        // Cache-only misses can occur on reload before server data arrives.
        // Never initialize from that state, otherwise existing onboarding can be reset.
        if (snapshot.metadata.fromCache) {
          return;
        }

        if (hasInitializedFromMissingDoc.current) {
          setLoading(false);
          return;
        }

        // Initialize onboarding only after the server confirms the doc is missing.
        hasInitializedFromMissingDoc.current = true;
        try {
          const newState = await initializeOnboarding(ctx);
          setState(newState);
          setLoading(false);
        } catch (err) {
          hasInitializedFromMissingDoc.current = false;
          console.error("Error initializing onboarding:", err);
          setError(err as Error);
          setLoading(false);
        }
      },
      (err) => {
        console.error("Error fetching onboarding state:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId, ctx]);

  // Auto-detect step completion based on existing data
  useEffect(() => {
    // Wait until everything is loaded and onboarding state has synced from server
    if (
      !isServerStateReady ||
      !state ||
      loading ||
      sourcesLoading ||
      transactionsLoading ||
      userDataLoading ||
      emailLoading ||
      !userId
    ) {
      return;
    }

    // Once onboarding is completed (including explicit "Skip setup"),
    // do not auto-reopen it based on subsequent data checks.
    if (state.isComplete) {
      return;
    }

    // Check each step and complete based on current conditions
    const syncStepsWithData = async () => {
      const isDataOnly = state.track === "data_only";

      // For data_only track, skip directly to bank steps
      if (!isDataOnly) {
        // Step 0: Set identity (name/company)
        if (!state.completedSteps.set_identity && hasIdentity) {
          await completeOnboardingStep(ctx, "set_identity");
          return;
        }

        // Step 1: Connect email (only check if step 0 is done, skip if user explicitly skipped)
        const hasEmailConnected = hasGmailIntegration;
        const isEmailSkipped = !!state.skippedSteps?.connect_email;
        if (state.completedSteps.set_identity && !isEmailSkipped) {
          if (!state.completedSteps.connect_email && hasEmailConnected) {
            await completeOnboardingStep(ctx, "connect_email");
            return;
          }
        }

        // Only proceed to bank steps if email step is done or skipped
        if (!state.completedSteps.connect_email) return;
      }

      // Bank steps (shared by both tracks)
      const hasSources = sources.length > 0;
      if (!state.completedSteps.add_bank_account && hasSources) {
        await completeOnboardingStep(ctx, "add_bank_account", sources[0]?.id);
        return;
      }

      const hasTransactions = transactions.length > 0;
      if (state.completedSteps.add_bank_account) {
        if (!state.completedSteps.import_transactions && hasTransactions) {
          await completeOnboardingStep(ctx, "import_transactions");
          return;
        }
      }

      // For data_only, onboarding ends after import_transactions
      if (isDataOnly) return;

      // Full service: additional steps
      const transactionWithPartner = transactions.find((t) => t.partnerId);
      if (state.completedSteps.import_transactions) {
        if (!state.completedSteps.assign_partner && transactionWithPartner) {
          await completeOnboardingStep(ctx, "assign_partner", transactionWithPartner.id);
          return;
        }
      }

      const transactionWithFileOrCategory = transactions.find(
        (t) =>
          (t.fileIds && t.fileIds.length > 0) ||
          t.noReceiptCategoryId
      );
      if (state.completedSteps.assign_partner) {
        if (!state.completedSteps.attach_file && transactionWithFileOrCategory) {
          await completeOnboardingStep(ctx, "attach_file", transactionWithFileOrCategory.id);
          return;
        }
      }
    };

    syncStepsWithData();
  }, [
    state,
    sources,
    transactions,
    loading,
    sourcesLoading,
    transactionsLoading,
    userDataLoading,
    emailLoading,
    hasIdentity,
    hasGmailIntegration,
    userId,
    ctx,
    isServerStateReady,
  ]);

  const resolvedState = isServerStateReady ? state : null;
  const resolvedLoading =
    !!userId &&
    (
      loading ||
      !isServerStateReady ||
      sourcesLoading ||
      transactionsLoading ||
      userDataLoading ||
      emailLoading
    );

  // Track-filtered steps
  const track = resolvedState?.track;
  const filteredSteps = useMemo(
    () => getStepsForTrack(track),
    [track]
  );

  // Get current step config
  const currentStepConfig = useMemo((): OnboardingStepConfig | null => {
    if (!resolvedState) return null;
    return filteredSteps.find((s) => s.id === resolvedState.currentStep) || null;
  }, [resolvedState, filteredSteps]);

  // Calculate progress based on filtered steps
  const progress = useMemo(() => {
    if (!resolvedState) {
      return { completed: 0, total: filteredSteps.length, percentage: 0 };
    }
    const completed = filteredSteps.filter(
      (s) => !!resolvedState.completedSteps[s.id]
    ).length;
    return {
      completed,
      total: filteredSteps.length,
      percentage: Math.round((completed / filteredSteps.length) * 100),
    };
  }, [resolvedState, filteredSteps]);

  // Check if a step is completed
  const isStepCompleted = useCallback(
    (step: OnboardingStep): boolean => {
      return !!resolvedState?.completedSteps[step];
    },
    [resolvedState]
  );

  // Check if a step was explicitly skipped
  const isStepSkipped = useCallback(
    (step: OnboardingStep): boolean => {
      return !!resolvedState?.skippedSteps?.[step];
    },
    [resolvedState]
  );

  // Skip entire onboarding
  const skipOnboarding = useCallback(async () => {
    try {
      await skipOnboardingOp(ctx);
    } catch (err) {
      console.error("Error skipping onboarding:", err);
    }
  }, [ctx]);

  // Skip a single step
  const skipStep = useCallback(
    async (step: OnboardingStep) => {
      try {
        await skipOnboardingStep(ctx, step);
      } catch (err) {
        console.error("Error skipping step:", err);
      }
    },
    [ctx]
  );

  // Mark completion seen
  const dismissCompletion = useCallback(async () => {
    try {
      console.log("[Onboarding] Dismissing completion dialog.");
      await markOnboardingCompletionSeen(ctx);
      console.log("[Onboarding] Marked completion as seen.");
      const docRef = doc(db, "users", userId ?? "", "settings", "onboarding");
      const snapshot = await getDoc(docRef);
      console.log("[Onboarding] Readback after dismiss:", snapshot.data());
    } catch (err) {
      console.error("Error dismissing completion:", err);
    }
  }, [ctx, userId]);

  return {
    // State
    state,
    loading: resolvedLoading,
    error,

    // Track
    track,
    needsWelcome: resolvedState ? !resolvedState.track && !resolvedState.isComplete : false,

    // Derived state
    isOnboarding: resolvedState ? !resolvedState.isComplete : false,
    isComplete: resolvedState?.isComplete ?? false,
    showCompletion:
      resolvedState?.isComplete === true && resolvedState?.hasSeenCompletion === false,
    currentStep: resolvedState?.currentStep ?? null,
    currentStepConfig,

    // Step info (filtered by track)
    steps: filteredSteps,
    isStepCompleted,
    isStepSkipped,
    progress,

    // Actions
    dismissCompletion,
    skipOnboarding,
    skipStep,
  };
}
