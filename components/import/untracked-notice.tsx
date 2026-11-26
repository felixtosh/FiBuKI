"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CalendarX } from "lucide-react";

type Counts = Record<string, number> | null | undefined;

/**
 * Rows an Import or a bank sync skipped because they lie before Tracked From
 * (#794, ADR-0018), per fiscal year, with the way to bring them in. Nothing
 * is shown when none were skipped.
 */
export function UntrackedNotice({ byFiscalYear }: { byFiscalYear: Counts }) {
  const t = useTranslations("settings.fiscalYears.untrackedNotice");
  const years = Object.entries(byFiscalYear ?? {}).filter(([, count]) => count > 0).sort(([a], [b]) => b.localeCompare(a));
  if (years.length === 0) return null;
  const total = years.reduce((sum, [, count]) => sum + count, 0);
  const list = years.map(([year, count]) => t("year", { year, count })).join(", ");

  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-border bg-muted p-3 text-sm">
      <CalendarX className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-medium">{t("title", { count: total })}</p>
        <p className="text-muted-foreground">{list}</p>
        <Link href="/settings/fiscal-years" className="text-primary underline-offset-4 hover:underline">
          {t("link")}
        </Link>
      </div>
    </div>
  );
}
