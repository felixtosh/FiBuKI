"use client";

import { X, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface PillProps {
  label: string;
  icon?: React.ElementType;
  variant?: "default" | "suggestion";
  confidence?: number;
  /** How the item was matched - shows checkmark instead of confidence when manual */
  matchedBy?: "manual" | "auto" | "suggestion" | null;
  onRemove?: () => void;
  onClick?: () => void;
  disabled?: boolean;
  /** Animate entrance with pop-in effect */
  animate?: boolean;
  className?: string;
}

export function Pill({
  label,
  icon: Icon,
  variant = "default",
  confidence,
  matchedBy,
  onRemove,
  onClick,
  disabled,
  animate,
  className,
}: PillProps) {
  const isInteractive = onRemove || onClick;
  const isSuggestion = variant === "suggestion";

  const handleClick = () => {
    if (disabled) return;
    if (onClick) {
      onClick();
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
        "inline-flex items-center h-7 px-3 gap-2 rounded-md border text-sm max-w-full min-w-0",
        isSuggestion
          ? "bg-info border-info-border text-info-foreground hover:bg-info/80"
          : "bg-background border-input",
        isInteractive && "cursor-pointer",
        !isSuggestion && isInteractive && "hover:bg-accent",
        disabled && "opacity-50 cursor-not-allowed",
        animate && "animate-pill-pop",
        className
      )}
      onClick={isInteractive ? handleClick : undefined}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
    >
      {Icon && (
        <Icon
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0",
            isSuggestion ? "text-info-foreground" : "text-muted-foreground"
          )}
        />
      )}
      <span className="truncate">{label}</span>
      {matchedBy === "manual" ? (
        <span className="inline-flex items-center gap-0.5 text-xs flex-shrink-0 ml-auto text-green-600">
          <UserCheck className="h-3 w-3" />
        </span>
      ) : confidence ? (
        <span
          className={cn(
            "text-xs flex-shrink-0 ml-auto",
            isSuggestion ? "text-info-foreground/70" : "text-muted-foreground"
          )}
        >
          {Math.round(confidence)}%
        </span>
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
