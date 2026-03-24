"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSubscription } from "@/hooks/use-subscription";
import type { PlanFeatureKey } from "@/types/billing";

export function SmartFeatureGuard({
  children,
  feature,
}: {
  children: React.ReactNode;
  feature: PlanFeatureKey;
}) {
  const { hasFeature, loading } = useSubscription();
  const router = useRouter();
  const allowed = hasFeature(feature);

  useEffect(() => {
    if (!loading && !allowed) {
      router.replace("/transactions");
    }
  }, [loading, allowed, router]);

  if (loading || !allowed) return null;
  return <>{children}</>;
}
