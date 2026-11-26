"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callFunction } from "@/lib/firebase/callable";

interface FiscalYearSettings {
  startMonth: number;
  trackedFrom: string;
  closedThrough: string | null;
}

interface FiscalYearChange {
  id: string;
  changedAt: string;
  via: "settings" | "mcp" | "chat" | "initial";
  previous: FiscalYearSettings | null;
  next: FiscalYearSettings;
}

interface GetFiscalYearsResponse {
  settings: FiscalYearSettings;
  changes: FiscalYearChange[];
}

interface UpdateFiscalYearsResponse {
  settings: FiscalYearSettings;
  record: FiscalYearChange | null;
}

/** The refusal reasons the server sends in an error's details (fiscalYears.ts). */
const REFUSALS = [
  "invalid",
  "after-current-month",
  "closed-before-tracked",
  "tracked-after-gap",
  "tracked-from-holds-data",
] as const;

// Aliases kept above any JSX or arrow, so the UI string lint reads no generic as text.
type Stored = GetFiscalYearsResponse | null;
type Draft = FiscalYearSettings | null;
type Message = { kind: "ok" | "error"; text: string } | null;
type Field = keyof FiscalYearSettings;
type Changed = { [K in Field]?: FiscalYearSettings[K] };
type Labels = { [K in Field]: string };
type Refusal = (typeof REFUSALS)[number];
type RefusalDetails = { reason?: string; month?: string } | undefined;

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const NONE = "none";
const FIRST_YEAR = 2000;

/** What one change record changed, field by field, old to new. */
function describeChange(change: FiscalYearChange, labels: Labels, none: string): string {
  const fields = Object.keys(labels) as Field[];
  return fields
    .filter((field) => (change.previous ? change.previous[field] : undefined) !== change.next[field])
    .map((field) => {
      const before = change.previous ? (change.previous[field] ?? none) : none;
      return `${labels[field]} ${before} → ${change.next[field] ?? none}`;
    })
    .join(", ");
}

/** The refusal reason a callable error carries, when it is one the screen can name. */
function refusalOf(err: unknown): { reason: Refusal; month: string } | null {
  const details = (err as { details?: RefusalDetails } | null)?.details;
  const reason = details?.reason;
  if (!reason || !(REFUSALS as readonly string[]).includes(reason)) return null;
  return { reason: reason as Refusal, month: details?.month ?? "" };
}

/**
 * A month, picked as a year and a month from lists: a browser's own month
 * field is free text in Firefox and Safari. `noneLabel` adds "nothing closed".
 */
function MonthPicker({
  id,
  value,
  onChange,
  disabled,
  monthName,
  noneLabel,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
  monthName: (month: number) => string;
  noneLabel?: string;
}) {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: currentYear - FIRST_YEAR + 1 }, (_, i) => currentYear - i);
  const year = value ? value.slice(0, 4) : NONE;
  const month = value ? String(Number(value.slice(5, 7))) : NONE;
  const compose = (y: string, m: string) => `${y}-${m.padStart(2, "0")}`;

  return (
    <div className="flex gap-2">
      <Select
        value={year}
        onValueChange={(y) => onChange(y === NONE ? null : compose(y, month === NONE ? "12" : month))}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {noneLabel ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={month}
        onValueChange={(m) => value && onChange(compose(value.slice(0, 4), m))}
        disabled={disabled || value === null}
      >
        <SelectTrigger className="w-36" aria-labelledby={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {value === null ? <SelectItem value={NONE}>{noneLabel}</SelectItem> : null}
          {MONTHS.map((m) => (
            <SelectItem key={m} value={String(m)}>
              {monthName(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The Fiscal Years section (#794, ADR-0018): start month, Tracked From and
 * Closed Through. Reads and writes through their callables; every save the
 * server accepts is recorded there, and a refusal is said in the User's
 * language from the reason the server gives.
 */
export function FiscalYearsCard() {
  const t = useTranslations("settings.fiscalYears");
  const locale = useLocale();
  const [stored, setStored] = useState(null as Stored);
  const [draft, setDraft] = useState(null as Draft);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null as Message);

  const load = useCallback(async () => {
    const res = (await callFunction("getFiscalYears", {})) as GetFiscalYearsResponse;
    setStored(res);
    setDraft(res.settings);
  }, []);

  useEffect(() => {
    load().catch(() => setMessage({ kind: "error", text: t("saveFailed") }));
  }, [load, t]);

  const monthName = (month: number) =>
    new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, 1)));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    try {
      // Only what changed, so a refusal names the value the User moved.
      const before = stored?.settings;
      const changed = Object.fromEntries(
        (Object.keys(draft) as Field[])
          .filter((field) => !before || before[field] !== draft[field])
          .map((field) => [field, draft[field]])
      ) as Changed;
      const res = (await callFunction("updateFiscalYears", changed)) as UpdateFiscalYearsResponse;
      await load();
      setMessage({ kind: "ok", text: res.record ? t("saved") : t("noChange") });
    } catch (err) {
      const refusal = refusalOf(err);
      setMessage({ kind: "error", text: refusal ? t(`refusal.${refusal.reason}`, { month: refusal.month }) : t("saveFailed") });
    } finally {
      setSaving(false);
    }
  };

  const labels = { startMonth: t("startMonth"), trackedFrom: t("trackedFrom"), closedThrough: t("closedThrough") };
  const changes = stored?.changes ?? [];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {draft ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="fy-start">{t("startMonth")}</Label>
              <Select
                value={String(draft.startMonth)}
                onValueChange={(value) => setDraft({ ...draft, startMonth: Number(value) })}
                disabled={saving}
              >
                <SelectTrigger id="fy-start">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((month) => (
                    <SelectItem key={month} value={String(month)}>
                      {monthName(month)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fy-tracked">{t("trackedFrom")}</Label>
              <MonthPicker
                id="fy-tracked"
                value={draft.trackedFrom}
                onChange={(value) => value && setDraft({ ...draft, trackedFrom: value })}
                disabled={saving}
                monthName={monthName}
              />
              <p className="text-xs text-muted-foreground">{t("trackedFromHelp")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fy-closed">{t("closedThrough")}</Label>
              <MonthPicker
                id="fy-closed"
                value={draft.closedThrough}
                onChange={(value) => setDraft({ ...draft, closedThrough: value })}
                disabled={saving}
                monthName={monthName}
                noneLabel={t("nothingClosed")}
              />
              <p className="text-xs text-muted-foreground">{t("closedThroughHelp")}</p>
            </div>
          </div>
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || !draft}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("save")}
          </Button>
          {message ? (
            <p role="status" className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
              {message.text}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("changes")}</p>
          {changes.length === 0 ? <p className="text-sm text-muted-foreground">{t("noChanges")}</p> : null}
          <ul className="space-y-1 text-sm text-muted-foreground">
            {changes.map((change) => (
              <li key={change.id}>
                {t("changeLine", {
                  when: new Date(change.changedAt).toLocaleString(locale, { timeZone: "Europe/Vienna" }),
                  what: `${describeChange(change, labels, t("nothingClosed"))} (${t(`via.${change.via}`)})`,
                })}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
