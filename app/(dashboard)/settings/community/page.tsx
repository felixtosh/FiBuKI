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
      <p className="text-sm text-muted-foreground">
        {t("githubText")}{" "}
        <a
          className="underline"
          href="https://github.com/felixtosh/TaxToolAT"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("githubLink")}
        </a>
      </p>
    </div>
  );
}
