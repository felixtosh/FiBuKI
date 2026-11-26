"use client";

import { useTranslations } from "next-intl";
import { FiscalYearsCard } from "@/components/settings/fiscal-years-card";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";

export default function FiscalYearsPage() {
  const t = useTranslations("settings.fiscalYears");
  return (
    <div className="space-y-6">
      <SettingsPageHeader title={t("title")} description={t("pageDescription")} className="mb-0" />
      <FiscalYearsCard />
    </div>
  );
}
