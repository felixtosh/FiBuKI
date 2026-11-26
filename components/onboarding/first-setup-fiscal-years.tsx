"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CURRENT_YEAR_STATUSES,
  defaultStatuses,
  setYearStatus,
  settingsFromStatuses,
  setupYears,
  viennaToday,
  type FirstSetupSettings,
  type YearStatus,
} from "@/lib/fiscal-years/first-setup";

const STATUSES: YearStatus[] = ["untracked", "closed", "open"];
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const YEARS_OFFERED = 5;

/**
 * First setup's question (#805, ADR-0018): which fiscal years FiBuKI tracks,
 * open or closed, the current one open by default (the User may close it). It reports the settings the
 * picks mean on every change; the caller saves them through updateFiscalYears.
 */
export function FirstSetupFiscalYears({
  onChange,
  today,
  startMonth: initialStartMonth = 1,
}: {
  onChange: (settings: FirstSetupSettings) => void;
  /** Today, `YYYY-MM-DD`; Vienna's today when left out. */
  today?: string;
  startMonth?: number;
}) {
  const t = useTranslations("settings.fiscalYears.firstSetup");
  const locale = useLocale();
  const [startMonth, setStartMonth] = useState(initialStartMonth);
  const [statuses, setStatuses] = useState(() => defaultStatuses(YEARS_OFFERED));
  const day = today ?? viennaToday();
  const years = useMemo(() => setupYears(day, startMonth, YEARS_OFFERED), [day, startMonth]);

  useEffect(() => {
    onChange(settingsFromStatuses(years, statuses, startMonth, day));
  }, [years, statuses, startMonth, day, onChange]);

  const monthName = (month: number) =>
    new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, 1)));

  const changeStartMonth = (value: string) => {
    setStartMonth(Number(value));
    setStatuses(defaultStatuses(YEARS_OFFERED));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="font-medium">{t("title")}</p>
        <p className="text-sm text-muted-foreground">{t("help")}</p>
      </div>
      <div className="flex items-center gap-3">
        <Label htmlFor="first-setup-start-month">{t("startMonth")}</Label>
        <Select value={String(startMonth)} onValueChange={changeStartMonth}>
          <SelectTrigger id="first-setup-start-month" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {monthName(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="space-y-2">
        {years.map((year, index) => (
          <li key={year.start} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium tabular-nums">
              {year.label}
              {index === 0 ? <span className="ml-2 font-normal text-muted-foreground">{t("current")}</span> : null}
            </span>
            <div role="radiogroup" aria-label={year.label} className="flex gap-1">
              {(index === 0 ? CURRENT_YEAR_STATUSES : STATUSES).map((status) => (
                <Button
                  key={status}
                  type="button"
                  size="sm"
                  variant={statuses[index] === status ? "default" : "outline"}
                  role="radio"
                  aria-checked={statuses[index] === status}
                  aria-label={`${year.label}: ${t(status)}`}
                  onClick={() => setStatuses((s) => setYearStatus(s, index, status))}
                >
                  {t(status)}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
