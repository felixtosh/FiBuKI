"use client";

import { useEffect, useState } from "react";
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

interface ImportCelebrationProps {
  open: boolean;
  onDismiss: () => void;
  stats: { imported: number; skipped: number };
}

export function ImportCelebration({
  open,
  onDismiss,
  stats,
}: ImportCelebrationProps) {
  const [showSparkles, setShowSparkles] = useState(false);

  useEffect(() => {
    if (open) {
      const sparkleTimer = setTimeout(() => setShowSparkles(true), 200);
      const autoDismiss = setTimeout(onDismiss, 5000);
      return () => {
        clearTimeout(sparkleTimer);
        clearTimeout(autoDismiss);
      };
    }
    queueMicrotask(() => setShowSparkles(false));
  }, [open, onDismiss]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-center pb-4">
          {/* Animated icon */}
          <div className="mx-auto mb-4 relative">
            <div
              className={cn(
                "w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center",
                "transition-transform duration-500",
                showSparkles && "scale-110"
              )}
            >
              <CheckCircle2
                className={cn(
                  "h-10 w-10 text-primary",
                  "transition-all duration-500",
                  showSparkles && "scale-110"
                )}
              />
            </div>

            {/* Sparkle decorations */}
            {showSparkles && (
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
            Your first import is done!
          </DialogTitle>
          <DialogDescription className="text-base mt-2">
            {stats.imported} transaction{stats.imported !== 1 ? "s" : ""} imported
            {stats.skipped > 0 && `, ${stats.skipped} skipped`}.
            You&apos;re ready to start matching receipts.
          </DialogDescription>
        </DialogHeader>

        {/* Action button */}
        <Button onClick={onDismiss} className="w-full mt-2">
          View Transactions
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
