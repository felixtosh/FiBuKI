"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  History,
  UserPlus,
  UserMinus,
  UserCheck,
  Paperclip,
  Unlink,
  Tag,
  Bot,
  Search,
  Zap,
  Building2,
  ChevronDown,
  FileText,
  FileX,
  FilePlus,
  FileCheck,
  Trash2,
  RotateCcw,
  Copy,
  Link2,
  Lightbulb,
  PencilLine,
  AlertTriangle,
  CreditCard,
  Gavel,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn, toDateSafe } from "@/lib/utils";
import { AutomationHistoryEntry, deriveActivityLevel } from "@/types/transaction";

/** Icon and colour per entry type. The label comes from messages (activity.types). */
const TYPE_STYLE: Record<string, { icon: typeof History; color: string }> = {
  partner_assigned: { icon: UserPlus, color: "text-blue-500" },
  partner_removed: { icon: UserMinus, color: "text-orange-500" },
  partner_suggested: { icon: Lightbulb, color: "text-blue-400" },
  file_connected: { icon: Paperclip, color: "text-green-600" },
  file_disconnected: { icon: Unlink, color: "text-orange-500" },
  transaction_connected: { icon: Paperclip, color: "text-green-600" },
  transaction_disconnected: { icon: Unlink, color: "text-orange-500" },
  transaction_suggested: { icon: Lightbulb, color: "text-blue-400" },
  connection_confirmed: { icon: UserCheck, color: "text-green-600" },
  category_assigned: { icon: Tag, color: "text-purple-500" },
  category_removed: { icon: Tag, color: "text-orange-500" },
  category_matched: { icon: Zap, color: "text-purple-500" },
  receipt_search: { icon: Search, color: "text-blue-500" },
  file_matching: { icon: Paperclip, color: "text-blue-500" },
  partner_matching: { icon: Bot, color: "text-blue-500" },
  company_check: { icon: Building2, color: "text-blue-500" },
  file_created: { icon: FilePlus, color: "text-green-600" },
  file_deleted: { icon: Trash2, color: "text-orange-500" },
  file_restored: { icon: RotateCcw, color: "text-blue-500" },
  extracted: { icon: FileText, color: "text-violet-500" },
  extraction_failed: { icon: AlertTriangle, color: "text-red-500" },
  marked_not_invoice: { icon: FileX, color: "text-orange-500" },
  facts_corrected: { icon: PencilLine, color: "text-blue-500" },
  facts_derived: { icon: FileCheck, color: "text-blue-500" },
  copy_marked: { icon: Copy, color: "text-orange-500" },
  copy_suggested: { icon: Copy, color: "text-blue-400" },
  receipt_linked: { icon: Link2, color: "text-green-600" },
  receipt_unlinked: { icon: Unlink, color: "text-orange-500" },
  correction_linked: { icon: Link2, color: "text-green-600" },
  category_suggested: { icon: Lightbulb, color: "text-purple-400" },
  transaction_edited: { icon: PencilLine, color: "text-blue-500" },
  reconciled: { icon: CreditCard, color: "text-green-600" },
  reconciliation_suggested: { icon: CreditCard, color: "text-blue-400" },
  ruling_recorded: { icon: Gavel, color: "text-blue-500" },
  ruling_revoked: { icon: Gavel, color: "text-orange-500" },
};

function statusDot(status: AutomationHistoryEntry["status"]) {
  switch (status) {
    case "completed":
      return "bg-green-500";
    case "failed":
      return "bg-red-500";
    case "pending":
      return "bg-yellow-500";
    default:
      return "bg-muted-foreground";
  }
}

function useRelativeTime() {
  const t = useTranslations("activity.time");
  return (timestamp: unknown): string => {
    const date = toDateSafe(timestamp);
    if (!date) return "";
    const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
    if (diffMins < 1) return t("justNow");
    if (diffMins < 60) return t("minutes", { n: diffMins });
    if (diffMins < 1440) return t("hours", { n: Math.floor(diffMins / 60) });
    if (diffMins < 10080) return t("days", { n: Math.floor(diffMins / 1440) });
    return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  };
}

function EntryRow({ entry }: { entry: AutomationHistoryEntry }) {
  const t = useTranslations("activity");
  const relative = useRelativeTime();
  const style = TYPE_STYLE[entry.type] ?? { icon: History, color: "text-muted-foreground" };
  const Icon = style.icon;
  const label = t.has(`types.${entry.type}`) ? t(`types.${entry.type}`) : entry.type;
  const isInfo = deriveActivityLevel(entry) === "info";
  const hasSummary = entry.summary && entry.summary !== label;

  return (
    <div className={cn("flex gap-2 py-1.5 px-1 text-xs", isInfo && "opacity-50")}>
      <Icon className={cn("h-3.5 w-3.5 flex-shrink-0 mt-0.5", style.color)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground/80">{label}</span>
          {entry.actor ? (
            <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t.has(`actors.${entry.actor}`) ? t(`actors.${entry.actor}`) : entry.actor}
            </span>
          ) : null}
          <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", statusDot(entry.status))} title={entry.status} />
          <span className="ml-auto flex-shrink-0 text-muted-foreground/60 tabular-nums">{relative(entry.ranAt)}</span>
        </div>
        {hasSummary ? <p className="text-muted-foreground mt-0.5 leading-snug">{entry.summary}</p> : null}
      </div>
    </div>
  );
}

interface ActivityHistoryProps {
  /** The item's `automationHistory`, in any order. */
  entries: AutomationHistoryEntry[] | undefined;
  /** Show the list open, without the collapsible header. */
  expandedByDefault?: boolean;
}

/**
 * The activity log of a Transaction or a File (#752): every change a person,
 * the matcher or an AI made to it, newest first. Suggestions and process
 * telemetry fold behind "more" once there are a few real changes.
 */
export function ActivityHistory({ entries: raw, expandedByDefault = false }: ActivityHistoryProps) {
  const t = useTranslations("activity");
  const [isOpen, setIsOpen] = useState(expandedByDefault);
  const [showAllInfo, setShowAllInfo] = useState(false);

  const entries = useMemo(
    () =>
      [...(raw ?? [])].sort(
        (a, b) => (toDateSafe(b.ranAt)?.getTime() ?? 0) - (toDateSafe(a.ranAt)?.getTime() ?? 0)
      ),
    [raw]
  );
  const { main, info } = useMemo(() => {
    const split: { main: AutomationHistoryEntry[]; info: AutomationHistoryEntry[] } = { main: [], info: [] };
    for (const entry of entries) {
      (deriveActivityLevel(entry) === "info" ? split.info : split.main).push(entry);
    }
    return split;
  }, [entries]);
  // Fold the info lines once there are three real changes.
  const foldInfo = Math.min(main.length, 3) === 3 && info.length !== 0 && !showAllInfo;
  const shown = foldInfo ? main : entries;

  const content = (
    <div className={cn(!expandedByDefault && "rounded-lg border bg-muted/30 p-3")}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">{t("empty")}</p>
      ) : (
        <div className="space-y-1">
          {shown.map((entry, index) => (
            <EntryRow key={`${entry.type}-${index}`} entry={entry} />
          ))}
          {foldInfo ? (
            <button
              type="button"
              onClick={() => setShowAllInfo(true)}
              className="flex items-center gap-1 py-1 px-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              <ChevronDown className="h-3 w-3" />
              {t("more", { n: info.length })}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );

  if (expandedByDefault) {
    return content;
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground">
          <History className="h-4 w-4" />
          <span>{t("title")}</span>
          {entries.length > 0 ? (
            <span className="ml-auto text-xs bg-muted px-2 py-0.5 rounded">{entries.length}</span>
          ) : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <ScrollArea className="max-h-[300px]">{content}</ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}
