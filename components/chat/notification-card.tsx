"use client";

import { Package, Link2, Sparkles, Eraser, Bot, Download, Upload, AlertCircle, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { AutoActionNotification, NotificationType } from "@/types/notification";
import { useChat } from "./chat-provider";
import { WorkerActivityCard } from "./worker-activity-card";

interface NotificationCardProps {
  notification: AutoActionNotification;
}

const typeConfig: Record<
  NotificationType,
  { icon: typeof Package; color: string }
> = {
  import_complete: {
    icon: Package,
    color: "text-blue-500",
  },
  partner_matching: {
    icon: Link2,
    color: "text-green-500",
  },
  pattern_learned: {
    icon: Sparkles,
    color: "text-purple-500",
  },
  patterns_cleared: {
    icon: Eraser,
    color: "text-orange-500",
  },
  worker_activity: {
    icon: Bot,
    color: "text-blue-500",
  },
  export_complete: {
    icon: Download,
    color: "text-green-500",
  },
  export_failed: {
    icon: AlertCircle,
    color: "text-red-500",
  },
  data_import_complete: {
    icon: Upload,
    color: "text-green-500",
  },
  data_import_failed: {
    icon: AlertCircle,
    color: "text-red-500",
  },
  reconciliation_suggestion: {
    icon: CreditCard,
    color: "text-blue-500",
  },
};

export function NotificationCard({
  notification,
}: NotificationCardProps) {
  // Route worker_activity to specialized card
  if (notification.type === "worker_activity") {
    return <WorkerActivityCard notification={notification} />;
  }

  const config = typeConfig[notification.type] ?? {
    icon: Sparkles,
    color: "text-muted-foreground",
  };
  const Icon = config.icon;

  // Format timestamp
  const formatTime = (timestamp: { toDate: () => Date } | Date) => {
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
  };

  return (
    <div className="flex flex-col gap-2 max-w-[95%] pb-3 border-b border-muted/50">
      {/* Header with icon and timestamp */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", config.color)} />
        <span>{formatTime(notification.createdAt)}</span>
      </div>

      {/* Message content - styled like assistant messages */}
      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 text-sm">
        <p className="font-medium">{notification.title}</p>
        <p className="text-muted-foreground">{notification.message}</p>
      </div>

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
