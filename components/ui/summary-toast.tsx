"use client";

import { cn } from "@/lib/utils";

export interface SummaryToastState {
  message: string;
  tone: "success" | "error";
}

export function SummaryToast({ toast }: { toast: SummaryToastState | null }) {
  if (!toast) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
      <div
        className={cn(
          "rounded-md px-4 py-2.5 text-sm font-medium shadow-lg border",
          toast.tone === "error"
            ? "bg-destructive text-destructive-foreground border-destructive"
            : "bg-foreground text-background border-foreground"
        )}
      >
        {toast.message}
      </div>
    </div>
  );
}
