"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import type { Subscription } from "@/types/billing";
import { PLANS } from "@/types/billing";

export function useSubscription() {
  const { user } = useAuth();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!user?.uid) {
      setSubscription(null);
      setLoading(false);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, "subscriptions", user.uid),
      (snapshot) => {
        if (snapshot.exists()) {
          setSubscription({ ...snapshot.data() } as Subscription);
        } else {
          setSubscription(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error("[useSubscription] Error:", err);
        setError(err);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, [user?.uid]);

  const plan = subscription?.plan || "free";
  const planConfig = PLANS[plan];

  // AI usage calculations
  const aiUsage = subscription?.aiUsageCurrentPeriodEur ?? 0;
  const aiLimit = subscription?.aiFairUseLimitEur ?? planConfig.aiFairUseLimitEur;
  const aiCredits = subscription?.aiCreditsEur ?? 0;
  const aiOverageCap = subscription?.aiOverageCapEur ?? 0;
  const aiOverageUsed = subscription?.aiOverageCurrentPeriodEur ?? 0;
  const aiPaused = subscription?.aiPaused ?? false;
  const aiUsagePercent = aiLimit > 0 ? Math.min(100, (aiUsage / aiLimit) * 100) : 0;

  // Transaction usage calculations
  const txCount = subscription?.transactionCountCurrentMonth ?? 0;
  const txLimit = planConfig.transactionLimit;
  const txUsagePercent = txLimit > 0 ? Math.min(100, (txCount / txLimit) * 100) : 0;

  return {
    subscription,
    loading,
    error,
    plan,
    planConfig,
    // AI budget
    aiUsage,
    aiLimit,
    aiCredits,
    aiOverageCap,
    aiOverageUsed,
    aiPaused,
    aiUsagePercent,
    // Transaction quota
    txCount,
    txLimit,
    txUsagePercent,
    // Stripe
    hasStripeCustomer: !!subscription?.stripeCustomerId,
    isActive: subscription?.stripeSubscriptionStatus === "active",
    isPastDue: subscription?.stripeSubscriptionStatus === "past_due",
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    // Admin overrides
    adminOverride: subscription?.adminOverride ?? null,
    isFreePlanOverride: subscription?.adminOverride === "free_plan",
    isPlanTester: subscription?.adminOverride === "plan_tester",
  };
}
