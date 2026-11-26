"use client";

import { useLocale, useTranslations } from "next-intl";
import { CalendarX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UntrackedChoice, UntrackedImportPreview } from "@/types/fiscal-years";

type Option = { id: UntrackedChoice; month: string | null };

/** Fiscal years, oldest first, as one list in the User's language ("2022 and 2023"). */
export function joinYears(years: string[], locale: string): string {
  const sorted = [...years].sort();
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(sorted);
  } catch {
    return sorted.join(", ");
  }
}

/**
 * The CSV Import preview's question (#805, ADR-0018): how many rows lie before
 * Tracked From, per fiscal year, and whether to track them as closed, track
 * them as open (offered only while nothing is closed), or skip them. Shows
 * nothing when no row lies before Tracked From.
 */
export function UntrackedImportChoice({
  preview,
  value,
  onChange,
}: {
  preview: UntrackedImportPreview;
  value: UntrackedChoice | null;
  onChange: (choice: UntrackedChoice) => void;
}) {
  const t = useTranslations("settings.fiscalYears.importChoice");
  const locale = useLocale();
  if (preview.untrackedCount <= 0) return null;

  const years = Object.keys(preview.untrackedByFiscalYear);
  const options: Option[] = [];
  if (preview.choices.closed) options.push({ id: "closed", month: preview.choices.closed.trackedFrom });
  if (preview.choices.open) options.push({ id: "open", month: preview.choices.open.trackedFrom });
  options.push({ id: "skip", month: null });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted p-4 text-sm">
      <div className="flex items-start gap-3">
        <CalendarX className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="font-medium">
            {t("title", { count: preview.untrackedCount, yearCount: years.length, years: joinYears(years, locale) })}
          </p>
          <p className="text-muted-foreground">{t("question")}</p>
        </div>
      </div>
      <div role="radiogroup" aria-label={t("question")} className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            role="radio"
            aria-checked={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "h-auto flex-col items-start whitespace-normal p-3 text-left",
              value === option.id ? "border-primary ring-1 ring-primary" : null
            )}
          >
            <span className="font-medium">{t(option.id)}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {option.month ? t(`${option.id}Help`, { month: option.month }) : t("skipHelp")}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
