"use client";

import { useMemo, useState } from "react";
import {
  History,
  UserPlus,
  UserMinus,
  Paperclip,
  Unlink,
  Tag,
  Bot,
  Search,
  Zap,
  Building2,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn, toDateSafe } from "@/lib/utils";
import {
  Transaction,
  AutomationHistoryEntry,
  deriveActivityLevel,
} from "@/types/transaction";

interface TransactionHistoryProps {
  transaction: Transaction;
  expandedByDefault?: boolean;
}

const TYPE_CONFIG: Record<
  string,
  { icon: typeof History; label: string; color: string }
> = {
  partner_assigned: {
    icon: UserPlus,
    label: "Partner assigned",
    color: "text-blue-500",
  },
  partner_removed: {
    icon: UserMinus,
    label: "Partner removed",
    color: "text-orange-500",
  },
  file_connected: {
    icon: Paperclip,
    label: "File connected",
    color: "text-green-600",
  },
  file_disconnected: {
    icon: Unlink,
    label: "File disconnected",
    color: "text-orange-500",
  },
  category_assigned: {
    icon: Tag,
    label: "Category assigned",
    color: "text-purple-500",
  },
  category_removed: {
    icon: Tag,
    label: "Category removed",
    color: "text-orange-500",
  },
  category_matched: {
    icon: Zap,
    label: "Category auto-matched",
    color: "text-purple-500",
  },
  receipt_search: {
    icon: Search,
    label: "Receipt search",
    color: "text-blue-500",
  },
  file_matching: {
    icon: Paperclip,
    label: "File matching",
    color: "text-blue-500",
  },
  partner_matching: {
    icon: Bot,
    label: "Partner matching",
    color: "text-blue-500",
  },
  company_check: {
    icon: Building2,
    label: "Company check",
    color: "text-blue-500",
  },
};

function getStatusDot(status: AutomationHistoryEntry["status"]) {
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

function formatRelativeTime(timestamp: { toDate?: () => Date }): string {
  if (!timestamp?.toDate) return "";
  const date = timestamp.toDate();
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

const ACTOR_LABEL: Record<string, string> = {
  manual: "Manual",
  suggestion: "Suggestion",
  auto: "Auto",
  ai: "AI",
};

function EntryRow({ entry, index }: { entry: AutomationHistoryEntry; index: number }) {
  const level = deriveActivityLevel(entry);
  const config = TYPE_CONFIG[entry.type] || {
    icon: History,
    label: entry.type,
    color: "text-muted-foreground",
  };
  const Icon = config.icon;
  const isInfo = level === "info";

  // Show summary only if it adds info beyond the type label
  const hasSummary = entry.summary && entry.summary !== config.label;

  return (
    <div
      key={`${entry.type}-${index}`}
      className={cn(
        "flex gap-2 py-1.5 px-1 text-xs",
        isInfo && "opacity-50"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 flex-shrink-0 mt-0.5", config.color)} />

      <div className="flex-1 min-w-0">
        {/* Line 1: type label + actor badge + status dot + time */}
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-foreground/80">
            {config.label}
          </span>

          {entry.actor && (
            <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {ACTOR_LABEL[entry.actor] || entry.actor}
            </span>
          )}

          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full flex-shrink-0",
              getStatusDot(entry.status)
            )}
            title={entry.status}
          />

          <span className="ml-auto flex-shrink-0 text-muted-foreground/60 tabular-nums">
            {formatRelativeTime(entry.ranAt)}
          </span>
        </div>

        {/* Line 2: summary (wraps, not truncated) */}
        {hasSummary && (
          <p className="text-muted-foreground mt-0.5 leading-snug">
            {entry.summary}
          </p>
        )}
      </div>
    </div>
  );
}

export function TransactionHistory({
  transaction,
  expandedByDefault = false,
}: TransactionHistoryProps) {
  const [isOpen, setIsOpen] = useState(expandedByDefault);
  const [showAllInfo, setShowAllInfo] = useState(false);

  const entries = useMemo(() => {
    const history = transaction.automationHistory || [];
    return [...history].sort((a, b) => {
      const aTime = toDateSafe(a.ranAt)?.getTime() ?? 0;
      const bTime = toDateSafe(b.ranAt)?.getTime() ?? 0;
      return bTime - aTime;
    });
  }, [transaction.automationHistory]);

  const { nonInfoEntries, infoEntries } = useMemo(() => {
    const nonInfo: typeof entries = [];
    const info: typeof entries = [];
    for (const entry of entries) {
      if (deriveActivityLevel(entry) === "info") {
        info.push(entry);
      } else {
        nonInfo.push(entry);
      }
    }
    return { nonInfoEntries: nonInfo, infoEntries: info };
  }, [entries]);

  // Collapse info entries behind "Show all" if there are 3+ non-info entries
  const shouldCollapseInfo = nonInfoEntries.length >= 3 && infoEntries.length > 0;

  const content = (
    <div
      className={cn(!expandedByDefault && "rounded-lg border bg-muted/30 p-3")}
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No activity yet</p>
      ) : (
        <div className="space-y-1">
          {shouldCollapseInfo ? (
            <>
              {nonInfoEntries.map((entry, index) => (
                <EntryRow key={`${entry.type}-${index}`} entry={entry} index={index} />
              ))}
              {!showAllInfo ? (
                <button
                  onClick={() => setShowAllInfo(true)}
                  className="flex items-center gap-1 py-1 px-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  <ChevronDown className="h-3 w-3" />
                  {infoEntries.length} more
                </button>
              ) : (
                infoEntries.map((entry, index) => (
                  <EntryRow key={`info-${entry.type}-${index}`} entry={entry} index={index} />
                ))
              )}
            </>
          ) : (
            entries.map((entry, index) => (
              <EntryRow key={`${entry.type}-${index}`} entry={entry} index={index} />
            ))
          )}
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
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
        >
          <History className="h-4 w-4" />
          <span>Activity Log</span>
          {entries.length > 0 && (
            <span className="ml-auto text-xs bg-muted px-2 py-0.5 rounded">
              {entries.length}
            </span>
          )}
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2">
        <ScrollArea className="max-h-[300px]">{content}</ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}
