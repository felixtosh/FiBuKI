"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FirstSetupFiscalYears } from "@/components/onboarding/first-setup-fiscal-years";
import { useOnboarding } from "@/hooks/use-onboarding";
import { callFunction } from "@/lib/firebase/callable";
import type { FirstSetupSettings } from "@/lib/fiscal-years/first-setup";
import type { OnboardingOrigin } from "@/types/onboarding";

/** The picks as first shown and as they are now. */
type FiscalYearsPick = { initial: FirstSetupSettings | null; current: FirstSetupSettings | null };

function samePick(a: FirstSetupSettings, b: FirstSetupSettings): boolean {
  return a.startMonth === b.startMonth && a.trackedFrom === b.trackedFrom && a.closedThrough === b.closedThrough;
}

/** Assistants a user can arrive from, and where "back" goes. Codex has no web page to return to. */
const ASSISTANTS: Partial<Record<OnboardingOrigin, { name: string; url?: string }>> = {
  chatgpt: { name: "ChatGPT", url: "https://chatgpt.com" },
  claude: { name: "Claude", url: "https://claude.ai" },
  codex: { name: "Codex" },
};

/**
 * Shown once to a new account. Someone who signed up through an assistant is told they
 * can keep working there or continue here (both see the same data); everyone else gets
 * a short start. Either way the first real step is the same: who you are.
 */
export function Welcome() {
  const t = useTranslations("onboarding.welcome");
  const router = useRouter();
  const { origin, markWelcomeSeen } = useOnboarding();
  const [busy, setBusy] = useState(false);

  const tSetup = useTranslations("settings.fiscalYears.firstSetup");
  const [fiscalYears, setFiscalYears] = useState<FiscalYearsPick>({ initial: null, current: null });
  const [setupError, setSetupError] = useState<string | null>(null);
  const onFiscalYearsChange = useCallback((picked: FirstSetupSettings) => {
    setFiscalYears((s) => ({ initial: s.initial ?? picked, current: picked }));
  }, []);

  const assistant = ASSISTANTS[origin];

  /**
   * First setup's fiscal years (#805), saved through the one settings writer,
   * which writes the change record. Untouched picks save nothing, so a User
   * whose stored default already reaches further back keeps it.
   */
  const saveFiscalYears = async () => {
    const { initial, current } = fiscalYears;
    if (!current || !initial || samePick(initial, current)) return;
    await callFunction("updateFiscalYears", current);
  };

  const start = async () => {
    setBusy(true);
    setSetupError(null);
    try {
      await saveFiscalYears();
    } catch (err) {
      console.error("Failed to save the fiscal years:", err);
      setSetupError(`${tSetup("failed")} ${err instanceof Error ? err.message : ""}`.trim());
      setBusy(false);
      return;
    }
    try {
      await markWelcomeSeen();
      router.push("/settings/identity");
    } catch (err) {
      console.error("Failed to acknowledge the welcome screen:", err);
      setBusy(false);
    }
  };

  const goBack = async () => {
    if (!assistant?.url) return;
    // Acknowledge first so the next visit to FiBuKI does not start with the welcome again.
    await markWelcomeSeen().catch(() => undefined);
    window.location.assign(assistant.url);
  };

  return (
    <Card className="max-w-xl w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
      <CardContent className="p-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            {assistant ? t("connectedTitle", { app: assistant.name }) : t("title")}
          </h1>
          <p className="text-muted-foreground">
            {assistant ? t("connectedBody", { app: assistant.name }) : t("intro")}
          </p>
        </div>

        <FirstSetupFiscalYears onChange={onFiscalYearsChange} />
        {setupError ? (
          <p role="alert" className="text-sm text-destructive">
            {setupError}
          </p>
        ) : null}

        <p className="text-sm text-muted-foreground">{t("identityWhy")}</p>

        <div className="flex flex-col sm:flex-row gap-3">
          <Button size="lg" onClick={start} disabled={busy} className="sm:min-w-[220px]">
            {assistant ? t("continueHere") : t("start")}
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
          {assistant?.url && (
            <Button size="lg" variant="outline" onClick={goBack} disabled={busy}>
              {t("backToApp", { app: assistant.name })}
            </Button>
          )}
        </div>

        {!assistant && <p className="text-xs text-muted-foreground">{t("alsoElsewhere")}</p>}
      </CardContent>
    </Card>
  );
}
