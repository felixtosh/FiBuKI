"use client";

import { useTranslations } from "next-intl";
import { Bot, User, WandSparkles, Zap } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AUTOMATION_KINDS,
  summarizeAutomations,
  type AutomationArea,
  type AutomationKind,
} from "@/lib/activity/automation-summary";
import type { AutomationHistoryEntry } from "@/types/transaction";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<AutomationKind, typeof Zap> = {
  auto: Zap,
  llm: Bot,
  magic: WandSparkles,
  manual: User,
};

interface AutomationSummaryRowProps {
  /** The item's `automationHistory`: the same entries the activity log shows. */
  entries: AutomationHistoryEntry[] | undefined;
  area: AutomationArea;
  /** Whether the item holds a match in this area right now. */
  matched: boolean;
  /** Opens the activity log, where every counted line is. */
  onOpenLog?: () => void;
  className?: string;
}

/**
 * Which kinds of automation ran on a Partner or a connections section, how
 * often, and which one made the standing match (green). Counted from the
 * activity log, never from a second source (lib/activity/automation-summary).
 */
export function AutomationSummaryRow({ entries, area, matched, onOpenLog, className }: AutomationSummaryRowProps) {
  const t = useTranslations("activity.summary");
  const summary = summarizeAutomations(entries, area, matched);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {AUTOMATION_KINDS.map((kind) => {
        const Icon = KIND_ICON[kind];
        const count = summary.counts[kind];
        const isMatch = summary.matchedBy === kind;
        return (
          <Tooltip key={kind}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenLog}
                aria-label={`${t(`kinds.${kind}.label`)}: ${count}`}
                className={cn(
                  "inline-flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-xs tabular-nums transition-colors",
                  isMatch
                    ? "border-amount-positive/40 bg-complete-row text-amount-positive"
                    : count > 0
                      ? "text-foreground/80 hover:bg-muted"
                      : "text-muted-foreground/50 hover:bg-muted"
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{count}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-xs">
              <p className="font-medium">{t(`kinds.${kind}.label`)}</p>
              <p className="text-muted-foreground">{t(`kinds.${kind}.description.${area}`)}</p>
              <p className="mt-1">
                {t("ran", { n: count })}
                {isMatch ? ` · ${t("madeMatch")}` : null}
              </p>
            </TooltipContent>
          </Tooltip>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-1 inline-flex h-7 items-center px-1">
            <Checkbox
              checked={matched}
              tabIndex={-1}
              aria-readonly
              aria-label={matched ? t(`matched.${area}`) : t(`unmatched.${area}`)}
              className={cn(
                "pointer-events-none",
                matched && "border-amount-positive data-[state=checked]:bg-amount-positive"
              )}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {matched ? t(`matched.${area}`) : t(`unmatched.${area}`)}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
