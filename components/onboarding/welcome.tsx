"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOnboarding } from "@/hooks/use-onboarding";
import type { OnboardingOrigin } from "@/types/onboarding";

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

  const assistant = ASSISTANTS[origin];

  const start = async () => {
    setBusy(true);
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
