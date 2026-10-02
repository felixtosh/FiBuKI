"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Sparkles, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { TelegramLogo } from "@/components/ui/telegram-logo";
import { COMMUNITY_SETTINGS_PATH } from "@/lib/config/community";

interface OnboardingCompletionProps {
  open: boolean;
  onDismiss: () => void;
}

export function OnboardingCompletion({
  open,
  onDismiss,
}: OnboardingCompletionProps) {
  const t = useTranslations("onboarding.completion");
  const [showConfetti, setShowConfetti] = useState(false);
  const router = useRouter();
  const telegram = useTranslations("onboarding.telegram");

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => setShowConfetti(true), 200);
      return () => clearTimeout(timer);
    }
    queueMicrotask(() => setShowConfetti(false));
  }, [open]);

  const handleDismiss = () => {
    onDismiss();
  };

  const joinTelegram = () => {
    onDismiss();
    router.push(COMMUNITY_SETTINGS_PATH);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center pb-4">
          {/* Animated icon */}
          <div className="mx-auto mb-4 relative">
            <div
              className={cn(
                "w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center",
                "transition-transform duration-500",
                showConfetti && "scale-110"
              )}
            >
              <CheckCircle2
                className={cn(
                  "h-10 w-10 text-primary",
                  "transition-all duration-500",
                  showConfetti && "scale-110"
                )}
              />
            </div>

            {/* Sparkle decorations */}
            {showConfetti && (
              <>
                <Sparkles
                  className={cn(
                    "absolute -top-2 -right-2 h-6 w-6 text-yellow-500",
                    "animate-in zoom-in fade-in duration-300"
                  )}
                />
                <Sparkles
                  className={cn(
                    "absolute -bottom-1 -left-3 h-5 w-5 text-yellow-500",
                    "animate-in zoom-in fade-in duration-500 delay-100"
                  )}
                />
                <Sparkles
                  className={cn(
                    "absolute top-0 -left-4 h-4 w-4 text-primary",
                    "animate-in zoom-in fade-in duration-500 delay-200"
                  )}
                />
              </>
            )}
          </div>

          <DialogTitle className="text-2xl font-bold">
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-base mt-2">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        {/* Features unlocked */}
        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          <p className="text-sm font-medium text-muted-foreground">{t("next")}</p>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
              <span>{t("assistant")}</span>
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
              <span>{t("matching")}</span>
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
              <span>{t("partners")}</span>
            </li>
          </ul>
        </div>

        {/* Friendly invite to the Telegram community */}
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <TelegramLogo className="h-9 w-9 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{telegram("title")}</p>
            <p className="text-xs text-muted-foreground">{telegram("text")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={joinTelegram}>
            {telegram("cta")}
          </Button>
        </div>

        {/* Action button */}
        <Button onClick={handleDismiss} className="w-full mt-4">
          {t("start")}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
