"use client";

import {
  AlertCircle,
  Bot,
  CreditCard,
  Download,
  Eraser,
  ExternalLink,
  FileSearch,
  Link2,
  Loader2,
  MessageSquare,
  Package,
  Receipt,
  Sparkles,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ToolStepList } from "@/design-system/tool-results";
import { cn } from "@/lib/utils";
import {
  AutoActionNotification,
  NotificationType,
  ToolCallSummary,
} from "@/types/notification";
import { WorkerType } from "@/types/worker";
import { useChat } from "./chat-provider";

interface NotificationCardProps {
  notification: AutoActionNotification;
}

const typeConfig: Record<
  NotificationType,
  { icon: typeof Package }
> = {
  import_complete: {
    icon: Package,
  },
  partner_matching: {
    icon: Link2,
  },
  pattern_learned: {
    icon: Sparkles,
  },
  patterns_cleared: {
    icon: Eraser,
  },
  worker_activity: {
    icon: Bot,
  },
  export_complete: {
    icon: Download,
  },
  export_failed: {
    icon: AlertCircle,
  },
  data_import_complete: {
    icon: Upload,
  },
  data_import_failed: {
    icon: AlertCircle,
  },
  reconciliation_suggestion: {
    icon: CreditCard,
  },
};

const workerIcons: Record<WorkerType, { icon: typeof Bot }> = {
  file_matching: {
    icon: FileSearch,
  },
  partner_matching: {
    icon: Bot,
  },
  file_partner_matching: {
    icon: FileSearch,
  },
  receipt_search: {
    icon: Receipt,
  },
  partner_file_batch: {
    icon: FileSearch,
  },
};

function formatTime(timestamp: { toDate: () => Date } | Date | null | undefined) {
  if (!timestamp) return "Just now";
  const date = "toDate" in timestamp ? timestamp.toDate() : timestamp;
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
  });
}

export function NotificationCard({
  notification,
}: NotificationCardProps) {
  const router = useRouter();
  const { loadSession, setActiveTab, markNotificationRead } = useChat();

  // Render worker activity with the same unified component
  if (notification.type === "worker_activity") {
    const workerType = notification.context.workerType as WorkerType;
    const workerConfig = workerType ? workerIcons[workerType] : null;
    const Icon = workerConfig?.icon || Bot;
    const sessionId = notification.context.sessionId;
    const fileId = notification.context.fileId;
    const fileName = notification.context.fileName;
    const transactionId = notification.context.transactionId;
    const transactionName = notification.context.transactionName;
    const toolSummary = (notification.context.toolSummary || []) as ToolCallSummary[];
    const status = notification.context.workerStatus;
    const primaryLabel = fileName || transactionName || notification.title;
    const summaryText = notification.message?.trim() || notification.title;
    const isRunning = status === "running";
    const iconColorClass =
      status === "failed"
        ? "text-red-500"
        : status === "completed"
          ? "text-green-500"
          : "text-muted-foreground";
    const hasEntityLink = Boolean(fileId || transactionId);

    const handleViewInChat = async () => {
      if (sessionId) {
        await loadSession(sessionId);
        setActiveTab("chat");
        markNotificationRead(notification.id);
      }
    };

    const handleOpenLinkedEntity = () => {
      if (fileId) {
        router.push(`/files?id=${fileId}`);
        return;
      }
      if (transactionId) {
        router.push(`/transactions?id=${transactionId}`);
      }
    };

    return (
      <div className="flex flex-col gap-1.5 pb-2 border-b border-muted/50">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          ) : (
            <Icon className={cn("h-3.5 w-3.5", iconColorClass)} />
          )}
          <span>{formatTime(notification.createdAt)}</span>
        </div>

        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-sm font-medium min-w-0 flex-1 truncate" title={primaryLabel}>
            {primaryLabel}
          </p>
          {hasEntityLink && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground flex-shrink-0"
              onClick={handleOpenLinkedEntity}
              title={fileId ? "Open file" : "Open transaction"}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {sessionId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground flex-shrink-0"
              onClick={handleViewInChat}
              title="View in chat"
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {toolSummary.length > 0 ? (
          <ToolStepList steps={toolSummary} />
        ) : (
          <p className="text-xs text-muted-foreground">{summaryText}</p>
        )}
      </div>
    );
  }

  const config = typeConfig[notification.type] ?? {
    icon: Sparkles,
  };
  const Icon = config.icon;
  const iconColor =
    notification.type === "export_failed" || notification.type === "data_import_failed"
      ? "text-red-500"
      : "text-green-500";
  const summaryText = notification.message?.trim() || notification.title;

  return (
    <div className="flex flex-col gap-1.5 pb-2 border-b border-muted/50">
      {/* Header with icon and timestamp */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", iconColor)} />
        <span>{formatTime(notification.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1.5 min-w-0">
        <p className="text-sm font-medium min-w-0 flex-1 truncate" title={notification.title}>
          {notification.title}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{summaryText}</p>

      {/* Transaction preview - same style as chat */}
      {notification.preview?.transactions &&
        notification.preview.transactions.length > 0 && (
          <TransactionMiniTable transactions={notification.preview.transactions} />
        )}
    </div>
  );
}

// Transaction mini-table matching the chat style
interface TransactionPreview {
  id: string;
  name: string;
  amount: number;
  partner?: string;
}

function TransactionMiniTable({ transactions }: { transactions: TransactionPreview[] }) {
  const { uiActions } = useChat();

  const formatAmount = (amount: number) => {
    const euros = amount / 100;
    return euros.toLocaleString("de-DE", {
      style: "currency",
      currency: "EUR",
    });
  };

  const handleRowClick = (transactionId: string) => {
    uiActions.scrollToTransaction(transactionId);
    uiActions.openTransactionSheet(transactionId);
  };

  // Show max 5 transactions
  const displayTransactions = transactions.slice(0, 5);
  const hasMore = transactions.length > 5;

  return (
    <div className="rounded-md border text-xs overflow-hidden">
      <table className="w-full">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left px-2 py-1 font-medium">Name</th>
            <th className="text-right px-2 py-1 font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {displayTransactions.map((t) => (
            <tr
              key={t.id}
              className="border-t border-muted/50 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => handleRowClick(t.id)}
            >
              <td className="px-2 py-1 truncate max-w-[140px]">
                {[t.partner, t.name].filter(Boolean).join(" - ") || "—"}
              </td>
              <td
                className={cn(
                  "px-2 py-1 text-right tabular-nums",
                  t.amount < 0 ? "text-amount-negative" : "text-amount-positive"
                )}
              >
                {formatAmount(t.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div className="px-2 py-1 text-center text-muted-foreground bg-muted/30 border-t">
          +{transactions.length - 5} more
        </div>
      )}
    </div>
  );
}
