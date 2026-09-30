"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocalePreference } from "@/hooks/use-locale-preference";
import { isLocale } from "@/lib/i18n/locale";

/** The UI language switch in General Settings (#168). */
export function LanguageCard() {
  const t = useTranslations("settings.language");
  const common = useTranslations("common");
  const current = useLocale();
  const router = useRouter();
  const { saveLocale } = useLocalePreference();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const onChange = async (value: string) => {
    if (!isLocale(value) || value === current) return;
    setSaving(true);
    setError(false);
    try {
      await saveLocale(value, "user");
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        <Select value={current} onValueChange={onChange} disabled={saving}>
          <SelectTrigger className="w-48" aria-label={t("title")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="de">{common("german")}</SelectItem>
            <SelectItem value="en">{common("english")}</SelectItem>
          </SelectContent>
        </Select>
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {error && <p className="text-sm text-destructive">{t("saveFailed")}</p>}
      </CardContent>
    </Card>
  );
}
