"use client";

import { ReactNode } from "react";
import { Check, Link2 } from "lucide-react";
import { connectionCountLabel } from "@/lib/matching/connection-count";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ClassificationBadge,
  ScoreBadge,
  type BadgeSize,
} from "@/design-system/tool-results/classification-badges";

export interface ClassificationBadgeConfig {
  /** Classification type */
  type: "receipt" | "link" | "pdf";
  /** Optional keywords for tooltip */
  keywords?: string[];
}

export interface ConnectResultRowProps {
  /** Unique identifier */
  id: string;
  /** Main title/name */
  title: string;
  /** Date string (already formatted) */
  date?: string;
  /** Formatted amount string */
  amount?: string;
  /** Amount color: positive (green) or negative (red) */
  amountType?: "positive" | "negative";
  /** Optional subtitle (shown below title) */
  subtitle?: string;
  /** Optional secondary subtitle (e.g., integration label) */
  secondarySubtitle?: string;
  /** Optional label badge (e.g., "Amount match") */
  labelBadge?: string;
  /** Additional metadata to show after date (e.g., "234 KB") */
  meta?: string;
  /** Optional icon element on the left */
  icon?: ReactNode;
  /** Whether this item is currently selected */
  isSelected?: boolean;
  /** Whether this item is already connected */
  isConnected?: boolean;
  /** Whether this item is highlighted as a suggestion/match */
  isHighlighted?: boolean;
  /** Highlight variant: "suggestion" (amber) or "strategy" (blue) */
  highlightVariant?: "suggestion" | "strategy";
  /** Match confidence percentage (0-100) */
  confidence?: number;
  /** Match signal labels for tooltip */
  matchSignals?: string[];
  /** Email classification badges with tooltips */
  classificationBadges?: ClassificationBadgeConfig[];
  /**
   * File Connections this row already has to something other than the item in
   * hand (#241, #243). Shown as a badge when above zero; never disables the row.
   */
  connectionCount?: number;
  /** What the Connections are to: a File row counts Transactions, and back. */
  connectionNoun?: "Transaction" | "File";
  /** Click handler */
  onClick?: () => void;
  /** Whether the button is disabled */
  disabled?: boolean;
}

/**
 * A standardized row component for connect overlays.
 * Used in both ConnectFileOverlay and ConnectTransactionOverlay.
 */
export function ConnectResultRow({
  title,
  date,
  amount,
  amountType,
  subtitle,
  secondarySubtitle,
  labelBadge,
  meta,
  icon,
  isSelected = false,
  isConnected = false,
  isHighlighted = false,
  highlightVariant = "suggestion",
  confidence,
  matchSignals = [],
  classificationBadges = [],
  connectionCount,
  connectionNoun = "Transaction",
  onClick,
  disabled = false,
}: ConnectResultRowProps) {
  const showConfidence = confidence != null && confidence > 0 && !isConnected;
  // A row connected to the item in hand keeps its "Connected" treatment instead.
  const showConnectionCount =
    connectionCount != null && connectionCount > 0 && !isConnected;

  return (
    <button
      type="button"
      disabled={disabled || isConnected}
      onClick={onClick}
      className={cn(
        "w-full flex items-start gap-3 p-3 rounded-md text-left transition-colors overflow-hidden",
        isSelected && "bg-primary/10 ring-1 ring-primary",
        !isSelected && !isConnected && !isHighlighted && "hover:bg-muted",
        isConnected && "opacity-50 cursor-not-allowed",
        isHighlighted && !isSelected && !isConnected && (
          highlightVariant === "strategy"
            ? "bg-blue-50 dark:bg-blue-950/20"
            : "bg-amber-50 dark:bg-amber-950/20"
        )
      )}
    >
      {/* Optional icon - caller provides the complete icon element with styling */}
      {icon}

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Title row */}
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium truncate flex-1 min-w-0">{title}</p>
          {isConnected && (
            <Badge variant="secondary" className="text-xs">
              <Link2 className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
          {showConnectionCount && (
            <Badge
              variant="outline"
              className="text-xs shrink-0"
              data-testid="connection-count-badge"
            >
              <Link2 className="h-3 w-3 mr-1" />
              {connectionCountLabel(connectionCount ?? 0, connectionNoun)}
            </Badge>
          )}
        </div>

        {/* Subtitle row (e.g., From name) */}
        {subtitle && (
          <p className="text-xs text-muted-foreground truncate">
            {subtitle}
          </p>
        )}

        {/* Secondary subtitle row (e.g., integration label) */}
        {secondarySubtitle && (
          <p className="text-[11px] text-muted-foreground truncate">
            {secondarySubtitle}
          </p>
        )}

        {/* Date/Amount/Meta/Confidence row */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mt-0.5">
          {date && <span>{date}</span>}
          {date && (amount || meta) && <span>·</span>}
          {amount && (
            <span
              className={cn(
                "font-medium",
                amountType === "negative" && "text-red-600",
                amountType === "positive" && "text-green-600"
              )}
            >
              {amount}
            </span>
          )}
          {amount && meta && <span>·</span>}
          {meta && <span>{meta}</span>}
          {labelBadge && (
            <Badge variant="secondary" className="text-xs py-0 h-4 text-green-600">
              {labelBadge}
            </Badge>
          )}
          {showConfidence && (
            <ScoreBadge
              score={confidence}
              size="md"
              showTooltip
              tooltipReasons={matchSignals}
            />
          )}
          {classificationBadges.map((badge, idx) => (
            <ClassificationBadge
              key={idx}
              type={badge.type}
              size="md"
              showTooltip
              tooltipKeywords={badge.keywords}
            />
          ))}
        </div>
      </div>

      {/* Selected check */}
      {isSelected && <Check className="h-4 w-4 text-primary flex-shrink-0 mt-1" />}
    </button>
  );
}
