"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Sparkles, ArrowRight, Terminal, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useOnboarding } from "@/hooks/use-onboarding";
import { useRouter } from "next/navigation";

interface OnboardingCompletionProps {
  open: boolean;
  onDismiss: () => void;
}

export function OnboardingCompletion({
  open,
  onDismiss,
}: OnboardingCompletionProps) {
  const [showConfetti, setShowConfetti] = useState(false);
  const { track } = useOnboarding();
  const router = useRouter();

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => setShowConfetti(true), 200);
      return () => clearTimeout(timer);
    }
    queueMicrotask(() => setShowConfetti(false));
  }, [open]);

  const isDataOnly = track === "data_only";

  const handleDismiss = () => {
    onDismiss();
    if (isDataOnly) {
      router.push("/settings/integrations");
    }
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
              {isDataOnly ? (
                <Terminal
                  className={cn(
                    "h-10 w-10 text-primary",
                    "transition-all duration-500",
                    showConfetti && "scale-110"
                  )}
                />
              ) : (
                <CheckCircle2
                  className={cn(
                    "h-10 w-10 text-primary",
                    "transition-all duration-500",
                    showConfetti && "scale-110"
                  )}
                />
              )}
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
            {isDataOnly ? "Bank Data Ready!" : "You're all set!"}
          </DialogTitle>
          <DialogDescription className="text-base mt-2">
            {isDataOnly
              ? "Your bank data is imported and ready to use via API and MCP."
              : "Congratulations! You've completed the setup. Your account is now ready to help you manage your transactions and receipts."}
          </DialogDescription>
        </DialogHeader>

        {/* Features unlocked */}
        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          <p className="text-sm font-medium text-muted-foreground">
            {isDataOnly ? "Next steps:" : "What's next:"}
          </p>
          <ul className="space-y-2 text-sm">
            {isDataOnly ? (
              <>
                <li className="flex items-center gap-2">
                  <Key className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>Create an API key for programmatic access</span>
                </li>
                <li className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>Connect Claude, ChatGPT, or OpenClaw via MCP</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>Use the API to query transactions programmatically</span>
                </li>
              </>
            ) : (
              <>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>AI assistant ready to help categorize transactions</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>Automatic receipt matching enabled</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
                  <span>Partner suggestions for faster bookkeeping</span>
                </li>
              </>
            )}
          </ul>
        </div>

        {/* Action button */}
        <Button onClick={handleDismiss} className="w-full mt-4">
          {isDataOnly ? "Go to Integrations" : "Start using FiBuKI"}
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
