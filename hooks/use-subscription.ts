"use client";

import { useCallback, useMemo, useState } from "react";
import {
  doc,
  type DocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useFirestoreDoc } from "@/lib/firebase/use-firestore-collection";
import { useAuth } from "@/components/auth";
import type { Subscription, PlanFeatureKey } from "@/types/billing";
import {
  PLANS,
  hasFeature as hasFeatureFn,
  TRIAL_DURATION_DAYS,
  TRIAL_TRANSACTION_LIMIT,
} from "@/types/billing";

function mapSubscription(snap: DocumentSnapshot): Subscription | null {
  if (!snap.exists()) return null;
  return { ...snap.data() } as Subscription;
}

export function useSubscription() {
  const { user } = useAuth();
  const uid = user?.uid;

  const ref = useMemo(
    () => (uid ? doc(db, "subscriptions", uid) : null),
    [uid],
  );

  const { data: subscription, loading, error } = useFirestoreDoc(
    ref,
    mapSubscription,
  );

  // Capture "now" once per mount; trial days remaining is derived deterministically
  // from this fixed reference, avoiding impure Date.now() calls during render.
  const [now] = useState(() => Date.now());

  const plan = subscription?.plan || "free";
  const planConfig = PLANS[plan];

  // AI usage calculations
  const aiUsage = subscription?.aiUsageCurrentPeriodEur ?? 0;
  const aiLimit =
    subscription?.aiFairUseLimitEur ?? planConfig.aiFairUseLimitEur;
  const aiCredits = subscription?.aiCreditsEur ?? 0;
  const aiOverageCap = subscription?.aiOverageCapEur ?? 0;
  const aiOverageUsed = subscription?.aiOverageCurrentPeriodEur ?? 0;
  const aiPaused = subscription?.aiPaused ?? false;
  const aiUsagePercent =
    aiLimit > 0 ? Math.min(100, (aiUsage / aiLimit) * 100) : 0;

  // Transaction usage calculations
  const txCount = subscription?.transactionCountCurrentMonth ?? 0;
  const txLimit = planConfig.transactionLimit;
  const txUsagePercent =
    txLimit > 0 ? Math.min(100, (txCount / txLimit) * 100) : 0;

  // Trial calculations
  const trialExpired = subscription?.trialExpired ?? false;
  const trialStartedAt = subscription?.trialStartedAt;
  const trialTxCount = subscription?.trialTransactionCount ?? 0;

  const {
    isOnTrial,
    trialDaysRemaining,
    trialTransactionsRemaining,
  } = useMemo(() => {
    if (trialExpired || !trialStartedAt) {
      return {
        isOnTrial: false,
        trialDaysRemaining: 0,
        trialTransactionsRemaining: 0,
      };
    }
    const startDate =
      typeof trialStartedAt === "object" && "seconds" in trialStartedAt
        ? new Date((trialStartedAt as { seconds: number }).seconds * 1000)
        : new Date(trialStartedAt as unknown as string);
    const daysSinceStart = Math.floor(
      (now - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const daysRemaining = Math.max(0, TRIAL_DURATION_DAYS - daysSinceStart);
    const txRemaining = Math.max(0, TRIAL_TRANSACTION_LIMIT - trialTxCount);
    return {
      isOnTrial: daysRemaining > 0 && txRemaining > 0,
      trialDaysRemaining: daysRemaining,
      trialTransactionsRemaining: txRemaining,
    };
  }, [trialExpired, trialStartedAt, trialTxCount, now]);

  // Grandfathering
  const grandfatheredUntilRaw = subscription?.grandfatheredUntil;
  const grandfatheredUntil = useMemo(() => {
    if (!grandfatheredUntilRaw) return null;
    if (
      typeof grandfatheredUntilRaw === "object" &&
      "seconds" in grandfatheredUntilRaw
    ) {
      return new Date(
        (grandfatheredUntilRaw as { seconds: number }).seconds * 1000,
      );
    }
    return null;
  }, [grandfatheredUntilRaw]);

  const bmdExportActive = subscription?.addons?.bmdExport?.active ?? false;

  const hasFeature = useCallback(
    (feature: PlanFeatureKey): boolean => {
      if (isOnTrial) {
        return PLANS.smart.planFeatures[feature];
      }
      if (feature === "bmdExport" && bmdExportActive) {
        return true;
      }
      return hasFeatureFn(plan, feature, grandfatheredUntil);
    },
    [plan, isOnTrial, grandfatheredUntil, bmdExportActive],
  );

  return {
    subscription,
    loading,
    error,
    plan,
    planConfig,
    aiUsage,
    aiLimit,
    aiCredits,
    aiOverageCap,
    aiOverageUsed,
    aiPaused,
    aiUsagePercent,
    txCount,
    txLimit,
    txUsagePercent,
    isOnTrial,
    trialDaysRemaining,
    trialTransactionsRemaining,
    trialExpired,
    hasFeature,
    hasStripeCustomer: !!subscription?.stripeCustomerId,
    isActive: subscription?.stripeSubscriptionStatus === "active",
    isPastDue: subscription?.stripeSubscriptionStatus === "past_due",
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    adminOverride: subscription?.adminOverride ?? null,
    isFreePlanOverride: subscription?.adminOverride === "free_plan",
    isPlanTester: subscription?.adminOverride === "plan_tester",
    automationMode:
      (subscription?.automationMode as "active" | "passive") ?? "active",
    grandfatheredUntil,
  };
}
