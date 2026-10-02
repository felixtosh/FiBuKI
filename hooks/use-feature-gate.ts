"use client";

import { useState, useCallback } from "react";
import { useSubscription } from "@/hooks/use-subscription";
import type { PlanFeatureKey } from "@/types/billing";

interface FeatureGateResult {
  /** Whether the feature is allowed for the current plan */
  allowed: boolean;
  /** Plan known and the feature not in it. False while loading or after a
   * read error, when `allowed` is only the "free" fallback. */
  denied: boolean;
  /** Show the upgrade prompt dialog */
  showUpgrade: () => void;
  /** Hide the upgrade prompt dialog */
  hideUpgrade: () => void;
  /** Whether the upgrade dialog is currently visible */
  upgradeVisible: boolean;
  /** The feature that triggered the gate */
  featureKey: PlanFeatureKey;
}

/**
 * Hook for gating UI features based on the current plan.
 * Returns `allowed` flag and upgrade dialog controls.
 *
 * Usage:
 * ```tsx
 * const { allowed, showUpgrade, upgradeVisible, hideUpgrade } = useFeatureGate("chatAssistant");
 * if (!allowed) return <Button onClick={showUpgrade}>Upgrade</Button>;
 * ```
 */
export function useFeatureGate(feature: PlanFeatureKey): FeatureGateResult {
  const { hasFeature, loading, error } = useSubscription();
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  const allowed = hasFeature(feature);
  const denied = !allowed && !loading && !error;

  const showUpgrade = useCallback(() => setUpgradeVisible(true), []);
  const hideUpgrade = useCallback(() => setUpgradeVisible(false), []);

  return {
    allowed,
    denied,
    showUpgrade,
    hideUpgrade,
    upgradeVisible,
    featureKey: feature,
  };
}
