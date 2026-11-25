"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  via: "settings" | "mcp" | "chat";
  previous: FiscalYearSettings;
  next: FiscalYearSettings;
}

interface GetFiscalYearsResponse {
  settings: FiscalYearSettings;
  changes: FiscalYearChange[];
}

// Aliases kept above any JSX or arrow, so the UI string lint reads no generic as text.
type Stored = GetFiscalYearsResponse | null;
type Draft = FiscalYearSettings | null;
type Message = { kind: "ok" | "error"; text: string } | null;
type Field = keyof FiscalYearSettings;
type Changed = { [K in Field]?: FiscalYearSettings[K] };
type Labels = { [K in Field]: string };

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** What one change record changed, field by field, old to new. */
function describeChange(change: FiscalYearChange, labels: Labels, none: string): string {
  const fields = Object.keys(labels) as Field[];
  return fields
    .filter((field) => change.previous[field] !== change.next[field])
    .map((field) => `${labels[field]} ${change.previous[field] ?? none} → ${change.next[field] ?? none}`)
    .join(", ");
}

/**
 * The Fiscal Years section (#794, ADR-0018): start month, Tracked From and
 * Closed Through. Reads and writes through their callables; every save the
 * server accepts is recorded there, and its refusals are shown as given.
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
      await callFunction("updateFiscalYears", changed);
      await load();
      setMessage({ kind: "ok", text: t("saved") });
    } catch (err) {
      const text = err instanceof Error && err.message ? err.message : t("saveFailed");
      setMessage({ kind: "error", text });
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
              <Input
                id="fy-tracked"
                type="month"
                value={draft.trackedFrom}
                onChange={(e) => e.target.value && setDraft({ ...draft, trackedFrom: e.target.value })}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">{t("trackedFromHelp")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fy-closed">{t("closedThrough")}</Label>
              <div className="flex gap-2">
                <Input
                  id="fy-closed"
                  type="month"
                  value={draft.closedThrough ?? ""}
                  placeholder={t("nothingClosed")}
                  onChange={(e) => setDraft({ ...draft, closedThrough: e.target.value || null })}
                  disabled={saving}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft({ ...draft, closedThrough: null })}
                  disabled={saving || draft.closedThrough === null}
                >
                  {t("clear")}
                </Button>
              </div>
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
            <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
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
