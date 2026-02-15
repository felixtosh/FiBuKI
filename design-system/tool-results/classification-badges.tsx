"use client";

import { FileText, Link2, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Shared classification and score badges for tool results and Connect UI.
 * Two sizes: "sm" for chat tool results, "md" for Connect File UI.
 */

export type BadgeSize = "sm" | "md";

// ============================================================================
// Score Badge (percentage)
// ============================================================================

interface ScoreBadgeProps {
  score: number;
  size?: BadgeSize;
  showTooltip?: boolean;
  tooltipReasons?: string[];
  className?: string;
}

function getScoreColor(score: number) {
  if (score >= 85) return "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300";
  if (score >= 70) return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
  if (score >= 50) return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
  return "bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300";
}

export function ScoreBadge({
  score,
  size = "sm",
  showTooltip = false,
  tooltipReasons = [],
  className,
}: ScoreBadgeProps) {
  const badge = (
    <Badge
      variant="outline"
      className={cn(
        getScoreColor(score),
        size === "sm" ? "text-[10px] py-0 h-4" : "text-xs py-0 h-5",
        showTooltip && "cursor-help",
        className
      )}
    >
      {score}%
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[240px] text-xs">
        <div className="font-medium mb-1">Match signals</div>
        <div className="space-y-0.5">
          {tooltipReasons.length > 0 ? (
            tooltipReasons.map((reason, idx) => (
              <div key={idx} className="text-muted-foreground">{reason}</div>
            ))
          ) : (
            <div className="text-muted-foreground">No specific signals</div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Score Label Badge (Likely / Strong)
// ============================================================================

interface ScoreLabelBadgeProps {
  label: "Likely" | "Strong";
  size?: BadgeSize;
  className?: string;
}

export function ScoreLabelBadge({ label, size = "sm", className }: ScoreLabelBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300",
        size === "sm" ? "text-[10px] py-0 h-4" : "text-xs py-0 h-5",
        className
      )}
    >
      {label}
    </Badge>
  );
}

// ============================================================================
// Rejected Badge
// ============================================================================

interface RejectedBadgeProps {
  size?: BadgeSize;
  className?: string;
}

export function RejectedBadge({ size = "sm", className }: RejectedBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "bg-orange-50 text-orange-900 border-orange-300 dark:bg-orange-900/50 dark:text-orange-200 cursor-help",
            size === "sm" ? "text-[10px] py-0 h-4" : "text-xs py-0 h-5",
            className
          )}
        >
          Rejected
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        This file was previously rejected for this transaction
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Classification Badges (Receipt, Link, PDF)
// ============================================================================

interface ClassificationBadgeProps {
  type: "receipt" | "link" | "pdf";
  size?: BadgeSize;
  showTooltip?: boolean;
  tooltipKeywords?: string[];
  className?: string;
}

const CLASSIFICATION_CONFIG = {
  receipt: {
    label: "Receipt",
    icon: FileText,
    colors: "bg-purple-50 text-purple-900 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300",
    tooltip: "Email body may be the invoice (order confirmation, receipt)",
  },
  link: {
    label: "Link",
    icon: Link2,
    colors: "bg-blue-50 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300",
    tooltip: "May contain invoice download link",
  },
  pdf: {
    label: "PDF",
    icon: Paperclip,
    colors: "bg-orange-50 text-orange-900 border-orange-300 dark:bg-orange-900/30 dark:text-orange-300",
    tooltip: "Has PDF attachment",
  },
} as const;

export function ClassificationBadge({
  type,
  size = "sm",
  showTooltip = true,
  tooltipKeywords = [],
  className,
}: ClassificationBadgeProps) {
  const config = CLASSIFICATION_CONFIG[type];
  const Icon = config.icon;
  const iconSize = size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3";

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        config.colors,
        size === "sm" ? "text-[10px] py-0 h-4" : "text-xs py-0 h-5",
        showTooltip && "cursor-help",
        className
      )}
    >
      <Icon className={cn(iconSize, "mr-0.5")} />
      {config.label}
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs max-w-[200px]">
        {config.tooltip}
        {tooltipKeywords.length > 0 && (
          <div className="mt-1 text-muted-foreground">
            Matched: {tooltipKeywords.join(", ")}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Classification Badges Group (renders all applicable badges in order)
// ============================================================================

interface EmailClassification {
  hasPdfAttachment?: boolean;
  possibleMailInvoice?: boolean;
  possibleInvoiceLink?: boolean;
  confidence?: number;
  matchedKeywords?: string[];
}

interface ClassificationBadgesProps {
  classification?: EmailClassification;
  scoreLabel?: "Likely" | "Strong" | null;
  score?: number;
  isRejected?: boolean;
  size?: BadgeSize;
  showTooltips?: boolean;
  className?: string;
}

/**
 * Renders all classification badges in consistent order:
 * PDF → Receipt → Link → Likely/Strong → Score%
 * Or just: Rejected (if rejected)
 */
export function ClassificationBadges({
  classification,
  scoreLabel,
  score,
  isRejected,
  size = "sm",
  showTooltips = true,
  className,
}: ClassificationBadgesProps) {
  // If rejected, only show rejected badge
  if (isRejected) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        <RejectedBadge size={size} />
      </div>
    );
  }

  const badges: React.ReactNode[] = [];

  // Order: PDF → Receipt → Link → Likely/Strong → Score%
  if (classification?.hasPdfAttachment) {
    badges.push(
      <ClassificationBadge
        key="pdf"
        type="pdf"
        size={size}
        showTooltip={showTooltips}
      />
    );
  }

  if (classification?.possibleMailInvoice) {
    badges.push(
      <ClassificationBadge
        key="receipt"
        type="receipt"
        size={size}
        showTooltip={showTooltips}
        tooltipKeywords={classification.matchedKeywords}
      />
    );
  }

  if (classification?.possibleInvoiceLink) {
    badges.push(
      <ClassificationBadge
        key="link"
        type="link"
        size={size}
        showTooltip={showTooltips}
        tooltipKeywords={classification.matchedKeywords}
      />
    );
  }

  if (scoreLabel) {
    badges.push(<ScoreLabelBadge key="label" label={scoreLabel} size={size} />);
  }

  if (score != null) {
    badges.push(
      <ScoreBadge
        key="score"
        score={score}
        size={size}
        showTooltip={false}
      />
    );
  }

  if (badges.length === 0) return null;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {badges}
    </div>
  );
}
