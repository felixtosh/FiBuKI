"use client";

import { useTranslations } from "next-intl";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";
import { CommunityCard } from "@/components/settings/community-card";

export default function CommunityPage() {
  const t = useTranslations("settings.community");
  return (
    <div className="space-y-6">
      <SettingsPageHeader title={t("title")} description={t("description")} />
      <CommunityCard />
    </div>
  );
}
