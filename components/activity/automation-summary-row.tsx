"use client";

import { useTranslations } from "next-intl";
import { Bot, FileText, Fingerprint, Loader2, Paperclip, User, WandSparkles, Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  summarizeAutomations,
  type AutomationLadder,
  type AutomationMethod,
} from "@/lib/activity/automation-summary";
import type { AutomationHistoryEntry } from "@/types/transaction";
import { cn } from "@/lib/utils";

const METHOD_ICON: Record<AutomationMethod, typeof Zap> = {
  vat: Fingerprint,
  rules: Zap,
  llm: Bot,
  name: FileText,
  file: Paperclip,
  magic: WandSparkles,
  manual: User,
};

interface AutomationSummaryRowProps {
  /** The item's `automationHistory`: the same entries the activity log shows. */
  entries: AutomationHistoryEntry[] | undefined;
  /** Which section's escalation order to show. */
  ladder: AutomationLadder;
  /** Whether the item holds a match in this area right now. */
  matched: boolean;
  /** Starts the AI agent for this area. Without it the Magic cell is a count like the others. */
  onMagic?: () => void;
  /** The agent is running for this item. */
  magicBusy?: boolean;
  className?: string;
}

/**
 * The automation ladder of a Partner or a connections section: its methods in
 * escalation order, how many log lines each wrote, and which one made the
 * standing match (green). Counted from the activity log, never from a second
 * source (lib/activity/automation-summary).
 *
 * The Magic cell is also the section's wand: it starts the AI agent.
 */
export function AutomationSummaryRow({
  entries,
  ladder,
  matched,
  onMagic,
  magicBusy = false,
  className,
}: AutomationSummaryRowProps) {
  const t = useTranslations("activity.summary");
  const summary = summarizeAutomations(entries, ladder, matched);

  return (
    <div className={cn("inline-flex h-6 items-stretch overflow-hidden rounded-md bg-muted", className)}>
      {summary.methods.map((kind, index) => {
        const count = summary.counts[kind] ?? 0;
        const isMatch = summary.matchedBy === kind;
        const isAction = kind === "magic" && !!onMagic;
        const cellClass = cn(
          "inline-flex w-9 items-center justify-center gap-1 text-xs tabular-nums",
          isMatch
            ? "bg-complete-row text-amount-positive"
            : count !== 0
              ? "text-foreground/80"
              : "text-muted-foreground/50",
          isAction && "cursor-pointer text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60"
        );
        return (
          <Tooltip key={kind}>
            <TooltipTrigger asChild>
              {isAction ? (
                <button type="button" onClick={onMagic} disabled={magicBusy} className={cellClass}>
                  <CellContent kind={kind} count={count} busy={magicBusy} />
                </button>
              ) : (
                <span tabIndex={0} className={cellClass}>
                  <CellContent kind={kind} count={count} busy={false} />
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-xs">
              <p className="font-medium">
                {kind === "manual" ? t(`methods.${kind}.label`) : t("step", { n: index + 1, label: t(`methods.${kind}.label`) })}
              </p>
              <p className="text-muted-foreground">{t(`methods.${kind}.description.${ladder}`)}</p>
              <p className="mt-1">
                {t("ran", { n: count })}
                {isMatch ? ` · ${t("madeMatch")}` : null}
              </p>
              {isAction ? <p className="mt-1 font-medium">{magicBusy ? t("magicRunning") : t("runMagic")}</p> : null}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function CellContent({ kind, count, busy }: { kind: AutomationMethod; count: number; busy: boolean }) {
  const Icon = busy ? Loader2 : METHOD_ICON[kind];
  return (
    <>
      <Icon className={cn("h-3 w-3 shrink-0", busy && "animate-spin")} />
      <span>{count}</span>
    </>
  );
}
