"use client";

import { SettingsPageHeader } from "@/components/ui/settings-page-header";
import { ReferralCard } from "@/components/billing/referral-card";
import { SocialPromoCard } from "@/components/billing/social-promo-card";

export default function ReferralPage() {
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Refer a Friend"
        description="Earn free months by sharing FiBuKI with others"
      />
      <ReferralCard />
      <SocialPromoCard />
    </div>
  );
}
