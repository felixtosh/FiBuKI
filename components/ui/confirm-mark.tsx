"use client";

import { Loader2, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ConfirmMarkProps {
  /** The User made or confirmed it. Shows the green user-check; otherwise the checkbox. */
  confirmed: boolean;
  /** Confirm it. Without this, an unconfirmed item shows nothing. */
  onConfirm?: () => void;
  /** Hover text on the green user-check. */
  confirmedLabel: string;
  /** Hover text and accessible name of the checkbox. */
  confirmLabel: string;
  /** A confirm in flight. */
  pending?: boolean;
  disabled?: boolean;
  /** Show the empty checkbox only while the row is hovered (rows with `group`). */
  revealOnHover?: boolean;
  className?: string;
}

/**
 * Whether the User stands behind a match the app made, beside the X that
 * removes it: the green user-check when they made or confirmed it, an empty
 * checkbox that confirms it when the matcher or the AI did. The matcher
 * learns from confirmed matches, so confirming is how a User teaches it.
 */
export function ConfirmMark({
  confirmed,
  onConfirm,
  confirmedLabel,
  confirmLabel,
  pending,
  disabled,
  revealOnHover,
  className,
}: ConfirmMarkProps) {
  if (pending) {
    return <Loader2 className={cn("h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground", className)} />;
  }

  if (confirmed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn("inline-flex flex-shrink-0 items-center text-green-600 dark:text-green-400", className)}
            aria-label={confirmedLabel}
          >
            <UserCheck className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{confirmedLabel}</TooltipContent>
      </Tooltip>
    );
  }

  if (!onConfirm) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role="checkbox"
          aria-checked={false}
          aria-label={confirmLabel}
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!disabled) onConfirm();
          }}
          className={cn(
            "inline-flex h-3.5 w-3.5 flex-shrink-0 rounded-sm border border-muted-foreground/60 transition-colors hover:border-green-600 hover:bg-green-600/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            revealOnHover && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
            className
          )}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{confirmLabel}</TooltipContent>
    </Tooltip>
  );
}
