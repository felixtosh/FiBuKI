"use client";

import { Bot, Loader2, FileSearch, MessageSquare, Receipt, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { AutoActionNotification, ToolCallSummary } from "@/types/notification";
import { WorkerType } from "@/types/worker";
import { Button } from "@/components/ui/button";
import { ToolStepList } from "@/design-system/tool-results";
import { cn } from "@/lib/utils";
import { useChat } from "./chat-provider";

interface WorkerActivityCardProps {
  notification: AutoActionNotification;
}

/**
 * Icon configuration for worker types
 */
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

/**
 * Expandable notification card for worker activity.
 * Shows summary in collapsed state, full transcript when expanded.
 * If there's a linked chat session, can navigate to it.
 */
export function WorkerActivityCard({ notification }: WorkerActivityCardProps) {
  const router = useRouter();
  const { loadSession, setActiveTab, markNotificationRead } = useChat();

  const workerType = notification.context.workerType as WorkerType;
  const workerConfig = workerType ? workerIcons[workerType] : null;
  const Icon = workerConfig?.icon || Bot;

  // Check if this notification has a linked chat session
  const sessionId = notification.context.sessionId;

  // Get file/transaction context for linking
  const fileId = notification.context.fileId;
  const fileName = notification.context.fileName;
  const transactionId = notification.context.transactionId;
  const transactionName = notification.context.transactionName;
  const toolSummary = (notification.context.toolSummary || []) as ToolCallSummary[];
  const status = notification.context.workerStatus;

  const handleViewInChat = async () => {
    if (sessionId) {
      await loadSession(sessionId);
      setActiveTab("chat");
      markNotificationRead(notification.id);
    }
  };

  const handleViewFile = () => {
    if (fileId) {
      router.push(`/files?id=${fileId}`);
    }
  };

  const handleViewTransaction = () => {
    if (transactionId) {
      router.push(`/transactions?id=${transactionId}`);
    }
  };

  const handleOpenLinkedEntity = () => {
    if (fileId) {
      handleViewFile();
      return;
    }
    if (transactionId) {
      handleViewTransaction();
    }
  };

  // Format timestamp (handles null from serverTimestamp before sync)
  const formatTime = (timestamp: { toDate: () => Date } | Date | null | undefined) => {
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
  };

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

  return (
    <div className="flex flex-col gap-1.5 pb-2 border-b border-muted/50">
      {/* Header with single stateful icon and timestamp */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
        ) : (
          <Icon className={cn("h-3.5 w-3.5", iconColorClass)} />
        )}
        <span>{formatTime(notification.createdAt)}</span>
      </div>

      {/* Main row: filename/title with right-side actions */}
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

      {/* Tool steps */}
      {toolSummary.length > 0 ? (
        <ToolStepList steps={toolSummary} />
      ) : (
        <p className="text-xs text-muted-foreground">{summaryText}</p>
      )}
    </div>
  );
}
