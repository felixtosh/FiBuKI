"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useSubscription } from "@/hooks/use-subscription";
import { useAuth } from "@/components/auth";

type BannerState = {
  message: string;
  variant: "amber" | "red";
  key: string; // sessionStorage dismiss key
};

function detectBannerState(sub: ReturnType<typeof useSubscription>): BannerState | null {
  // Priority order: most critical first
  if (sub.aiPaused) {
    return {
      message: "AI features paused — budget exhausted.",
      variant: "red",
      key: "billing-banner-ai-paused",
    };
  }

  if (sub.txCount >= sub.txLimit && sub.txLimit > 0) {
    return {
      message: `Transaction limit reached (${sub.txLimit}/${sub.txLimit}).`,
      variant: "red",
      key: "billing-banner-tx-limit",
    };
  }

  if (sub.aiUsagePercent >= 90) {
    return {
      message: `AI budget almost exhausted (${Math.round(sub.aiUsagePercent)}%).`,
      variant: "amber",
      key: "billing-banner-ai-90",
    };
  }

  if (sub.txUsagePercent >= 90) {
    return {
      message: `Transaction quota almost full (${sub.txCount}/${sub.txLimit}).`,
      variant: "amber",
      key: "billing-banner-tx-90",
    };
  }

  if (sub.isPastDue) {
    return {
      message: "Payment past due — please update your payment method.",
      variant: "red",
      key: "billing-banner-past-due",
    };
  }

  return null;
}

export function BillingLimitBanner() {
  const { isAdmin } = useAuth();
  const sub = useSubscription();
  const [dismissed, setDismissed] = useState<string | null>(null);

  const bannerState = sub.loading ? null : detectBannerState(sub);

  // Restore dismissed state from sessionStorage
  const bannerKey = bannerState?.key;
  useEffect(() => {
    if (!bannerKey) return;
    const wasDismissed = sessionStorage.getItem(bannerKey);
    queueMicrotask(() => setDismissed(wasDismissed));
  }, [bannerKey]);

  // Don't show for admins
  if (isAdmin) return null;

  // No banner needed
  if (!bannerState) return null;

  // Dismissed this session (but re-appears if state worsens / key changes)
  if (dismissed === bannerState.key) return null;

  const handleDismiss = () => {
    sessionStorage.setItem(bannerState.key, bannerState.key);
    setDismissed(bannerState.key);
  };

  const isRed = bannerState.variant === "red";

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-2 text-sm",
        isRed
          ? "bg-red-50 text-red-800 border-b border-red-200 dark:bg-red-950/30 dark:text-red-200 dark:border-red-900"
          : "bg-amber-50 text-amber-800 border-b border-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900"
      )}
    >
      <AlertTriangle className={cn("h-4 w-4 flex-shrink-0", isRed ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")} />
      <span className="flex-1">{bannerState.message}</span>
      <Link
        href="/settings/billing"
        className={cn(
          "font-medium underline underline-offset-2 whitespace-nowrap",
          isRed
            ? "text-red-700 hover:text-red-900 dark:text-red-300 dark:hover:text-red-100"
            : "text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        )}
      >
        Manage plan &rarr;
      </Link>
      <button
        onClick={handleDismiss}
        className={cn(
          "p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10",
          isRed ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"
        )}
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
