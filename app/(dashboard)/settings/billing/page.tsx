"use client";

import { SettingsPageHeader } from "@/components/ui/settings-page-header";
import { BillingPlanComparison } from "@/components/settings/billing-plan-comparison";
import { BillingUsageSection } from "@/components/settings/billing-usage-section";
import { BillingAddonsSection } from "@/components/settings/billing-addons-section";
import { useSubscription } from "@/hooks/use-subscription";
import { Skeleton } from "@/components/ui/skeleton";

export default function BillingPage() {
  const { loading } = useSubscription();

  if (loading) {
    return (
      <div className="space-y-6">
        <SettingsPageHeader
          title="Billing & Plan"
          description="Manage your subscription, AI budget, and usage"
        />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Billing & Plan"
        description="Manage your subscription, AI budget, and usage"
      />
      <BillingPlanComparison />
      <BillingUsageSection />
      <BillingAddonsSection />
    </div>
  );
}
