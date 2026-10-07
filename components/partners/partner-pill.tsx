"use client";

import { X, Building2, Globe, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ConfirmMark } from "@/components/ui/confirm-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PartnerPillProps {
  name: string;
  confidence?: number;
  /** How the partner was matched - shows badge instead of confidence for manual/ai */
  matchedBy?: "manual" | "ai" | "auto" | "suggestion" | null;
  onRemove?: () => void;
  /**
   * Confirm an automatic or AI assignment: re-assign it as the User's own, so
   * the matcher learns from it. Shows a check mark left of the X; a manual or
   * accepted assignment shows the green user-check instead.
   */
  onConfirm?: () => void;
  /** A confirm in flight. */
  confirming?: boolean;
  onClick?: (e?: React.MouseEvent) => void;
  variant?: "default" | "suggestion";
  partnerType?: "user" | "global";
  disabled?: boolean;
  /** Animate entrance with pop-in effect */
  animate?: boolean;
  className?: string;
}

export function PartnerPill({
  name,
  confidence,
  matchedBy,
  onRemove,
  onConfirm,
  confirming,
  onClick,
  variant = "default",
  partnerType,
  disabled,
  animate,
  className
}: PartnerPillProps) {
  const t = useTranslations("common.confirmMatch");
  const isInteractive = onRemove || onClick;
  const isSuggestion = variant === "suggestion";
  const isConfirmed = matchedBy === "manual" || matchedBy === "suggestion";

  const handleClick = (e: React.MouseEvent) => {
    if (disabled) return;
    // If there's an onClick, use it; otherwise use onRemove (legacy behavior)
    if (onClick) {
      onClick(e);
    } else if (onRemove) {
      onRemove();
    }
  };

  const handleRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled || !onRemove) return;
    onRemove();
  };

  return (
    <div
      className={cn(
        "inline-flex items-center h-7 px-3 gap-2 rounded-md border text-sm max-w-full min-w-0 transition-colors duration-300",
        isSuggestion
          ? "bg-info border-info-border text-info-foreground hover:bg-info/80"
          : "bg-background border-input",
        isInteractive && "cursor-pointer",
        !isSuggestion && isInteractive && "hover:bg-accent",
        disabled && "opacity-50 cursor-not-allowed",
        animate && "animate-pill-pop",
        className
      )}
      onClick={handleClick}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
    >
      {partnerType && (
        partnerType === "user" ? (
          <Building2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        ) : (
          <Globe className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        )
      )}
      <span className="truncate">{name}</span>
      {matchedBy === "ai" && !isConfirmed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center flex-shrink-0 ml-auto text-violet-500" aria-label={t("partnerAi")}>
              <Sparkles className="h-3 w-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("partnerAi")}</TooltipContent>
        </Tooltip>
      ) : !isConfirmed && confidence !== undefined ? (
        <span className={cn(
          "text-xs flex-shrink-0 ml-auto",
          isSuggestion ? "text-info-foreground/70" : "text-muted-foreground"
        )}>
          {Math.round(confidence)}%
        </span>
      ) : null}
      {!isSuggestion && (isConfirmed || onConfirm || confirming) ? (
        <ConfirmMark
          confirmed={isConfirmed}
          onConfirm={onConfirm}
          pending={confirming}
          disabled={disabled}
          confirmedLabel={t("partnerConfirmed")}
          confirmLabel={t("partnerConfirm")}
          className={isConfirmed || (matchedBy !== "ai" && confidence === undefined) ? "ml-auto" : undefined}
        />
      ) : null}
      {onRemove && (
        <button
          type="button"
          onClick={handleRemoveClick}
          className="flex-shrink-0 p-0.5 -mr-1 rounded hover:bg-destructive/10"
          disabled={disabled}
        >
          <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </div>
  );
}
