"use client";

import { Bot, Loader2, CheckCircle, XCircle, FileSearch, MessageSquare, Receipt, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { AutoActionNotification } from "@/types/notification";
import { WorkerType } from "@/types/worker";
import { Button } from "@/components/ui/button";
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
 * Status icon based on worker status
 */
function StatusIcon({ status }: { status?: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case "completed":
      return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    default:
      return null;
  }
}

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

  const status = notification.context.workerStatus;

  return (
    <div className="flex flex-col gap-2 max-w-[95%] pb-3 border-b border-muted/50">
      {/* Header with icon, status, and timestamp */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <StatusIcon status={status} />
        <span>{formatTime(notification.createdAt)}</span>
      </div>

      {/* Title and message */}
      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 text-sm">
        <p className="font-medium">{notification.title}</p>
        <p className="text-muted-foreground">{notification.message}</p>
      </div>

      {/* While running - show clickable link to file/transaction */}
      {status === "running" && (fileId || transactionId) && (
        <div className="flex items-center gap-2">
          {fileId && fileName && (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleViewFile}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              {fileName}
            </Button>
          )}
          {transactionId && transactionName && (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleViewTransaction}
            >
              <ExternalLink className="h-3 w-3 mr-1" />
              {transactionName}
            </Button>
          )}
        </div>
      )}

      {/* View in chat button - shows when there's a linked session */}
      {sessionId && status === "completed" && (
        <Button
          variant="ghost"
          size="sm"
          className="w-fit h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={handleViewInChat}
        >
          <MessageSquare className="h-3 w-3 mr-1" />
          View in chat
        </Button>
      )}
    </div>
  );
}
