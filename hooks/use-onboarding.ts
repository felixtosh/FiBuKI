"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import {
  OnboardingState,
  OnboardingStep,
  OnboardingStepConfig,
  ONBOARDING_STEPS,
} from "@/types/onboarding";
import { useAuth } from "@/components/auth";
import { useSources } from "./use-sources";
import { useTransactions } from "./use-transactions";
import { useUserData } from "./use-user-data";
import { useEmailIntegrations } from "./use-email-integrations";

/**
 * Onboarding state for the signed-in user.
 *
 * The browser only listens. Which steps are done is decided on the server from the
 * user's data (functions/src/onboarding), the same answer the MCP tools give, and every
 * change goes through a callable. This hook just tells the server when something the
 * steps depend on may have changed.
 */
export function useOnboarding() {
  const { userId } = useAuth();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isServerStateReady, setIsServerStateReady] = useState(false);

  const { sources, loading: sourcesLoading } = useSources();
  const { transactions, loading: transactionsLoading } = useTransactions();
  const { loading: userDataLoading, isConfigured: hasIdentity } = useUserData();
  const { hasGmailIntegration, loading: emailLoading } = useEmailIntegrations();

  // Guard against duplicate initialization attempts while awaiting listener updates
  const hasInitializedFromMissingDoc = useRef(false);

  // Real-time listener for onboarding state. All initial state transitions
  // are deferred via queueMicrotask so they happen event-handler-style rather
  // than from within the effect body.
  useEffect(() => {
    let cancelled = false;

    if (!userId) {
      queueMicrotask(() => {
        if (cancelled) return;
        setState(null);
        setLoading(false);
        setIsServerStateReady(false);
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setIsServerStateReady(false);
    });
    hasInitializedFromMissingDoc.current = false;

    const docRef = doc(db, "users", userId, "settings", "onboarding");

    const unsubscribe = onSnapshot(
      docRef,
      async (snapshot) => {
        if (!snapshot.metadata.fromCache) {
          setIsServerStateReady(true);
        }

        if (snapshot.exists()) {
          setState(snapshot.data() as OnboardingState);
          setLoading(false);
          return;
        }

        if (snapshot.metadata.fromCache) {
          return;
        }

        if (hasInitializedFromMissingDoc.current) {
          setLoading(false);
          return;
        }

        // No document yet: the server creates it (and starts the trial). The listener
        // above delivers the result.
        hasInitializedFromMissingDoc.current = true;
        try {
          await callFunction("initOnboarding", {});
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
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  // Ask the server to re-check the steps when the data they depend on changes. The
  // signature only decides WHEN to ask; the rules are the server's. Completed
  // onboarding never reopens, so nothing is asked once it is done.
  const dataSignature = [
    hasIdentity,
    hasGmailIntegration,
    sources.length,
    transactions.length,
    transactions.filter((t) => t.partnerId).length,
    transactions.filter((t) => (t.fileIds && t.fileIds.length > 0) || t.noReceiptCategoryId).length,
  ].join("|");
  const lastSyncedSignature = useRef<string | null>(null);
  const syncing = useRef(false);

  useEffect(() => {
    if (
      !isServerStateReady ||
      !state ||
      loading ||
      sourcesLoading ||
      transactionsLoading ||
      userDataLoading ||
      emailLoading ||
      !userId ||
      state.isComplete
    ) {
      return;
    }
    if (lastSyncedSignature.current === dataSignature || syncing.current) return;

    syncing.current = true;
    callFunction("syncOnboarding", {})
      .then(() => {
        lastSyncedSignature.current = dataSignature;
      })
      .catch((err) => console.error("Error syncing onboarding:", err))
      .finally(() => {
        syncing.current = false;
      });
  }, [
    state,
    loading,
    sourcesLoading,
    transactionsLoading,
    userDataLoading,
    emailLoading,
    userId,
    isServerStateReady,
    dataSignature,
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

  const currentStepConfig = useMemo((): OnboardingStepConfig | null => {
    if (!resolvedState) return null;
    return ONBOARDING_STEPS.find((s) => s.id === resolvedState.currentStep) || null;
  }, [resolvedState]);

  const progress = useMemo(() => {
    const total = ONBOARDING_STEPS.length;
    if (!resolvedState) return { completed: 0, total, percentage: 0 };
    const completed = ONBOARDING_STEPS.filter((s) => !!resolvedState.completedSteps[s.id]).length;
    return { completed, total, percentage: Math.round((completed / total) * 100) };
  }, [resolvedState]);

  const isStepCompleted = useCallback(
    (step: OnboardingStep): boolean => !!resolvedState?.completedSteps[step],
    [resolvedState]
  );

  const isStepSkipped = useCallback(
    (step: OnboardingStep): boolean => !!resolvedState?.skippedSteps?.[step],
    [resolvedState]
  );

  const skipOnboarding = useCallback(async () => {
    try {
      await callFunction("updateOnboarding", { action: "skip_all" });
    } catch (err) {
      console.error("Error skipping onboarding:", err);
    }
  }, []);

  const skipStep = useCallback(async (step: OnboardingStep) => {
    try {
      await callFunction("updateOnboarding", { action: "skip_step", step });
    } catch (err) {
      console.error("Error skipping step:", err);
    }
  }, []);

  const dismissCompletion = useCallback(async () => {
    try {
      await callFunction("updateOnboarding", { action: "completion_seen" });
    } catch (err) {
      console.error("Error dismissing completion:", err);
    }
  }, []);

  const markWelcomeSeen = useCallback(async () => {
    await callFunction("updateOnboarding", { action: "welcome_seen" });
  }, []);

  // A fresh account sees the welcome screen once. Accounts from the removed track
  // choice have already been through a welcome.
  const needsWelcome = resolvedState
    ? !resolvedState.isComplete && !resolvedState.welcomeSeen && !resolvedState.track
    : false;

  return {
    // State
    state,
    loading: resolvedLoading,
    error,

    origin: resolvedState?.origin ?? "web",
    needsWelcome,

    // Derived state
    isOnboarding: resolvedState ? !resolvedState.isComplete : false,
    isComplete: resolvedState?.isComplete ?? false,
    showCompletion:
      resolvedState?.isComplete === true && resolvedState?.hasSeenCompletion === false,
    currentStep: resolvedState?.currentStep ?? null,
    currentStepConfig,

    // Step info
    steps: ONBOARDING_STEPS,
    isStepCompleted,
    isStepSkipped,
    progress,

    // Actions
    dismissCompletion,
    skipOnboarding,
    skipStep,
    markWelcomeSeen,
  };
}
