"use client";

import { Wrench, CheckCircle, XCircle, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { RuntimeChatMessage, MessagePart, ToolCall } from "@/types/chat";
import { Badge } from "@/components/ui/badge";
import { useChat } from "./chat-provider";
import { useToolResultRenderer } from "@/hooks/use-tool-result-renderer";

interface MessageBubbleProps {
  message: RuntimeChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  // User messages: bubble without icon
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-primary text-primary-foreground">
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant messages: render parts in order, no icon, no bubble
  return (
    <div className="flex flex-col gap-2 max-w-[95%]">
      {message.parts && message.parts.length > 0 ? (
        // Render parts in chronological order
        message.parts.map((part, index) => (
          <MessagePartRenderer key={index} part={part} />
        ))
      ) : (
        // Fallback to content string
        message.content && (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 text-sm">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )
      )}
    </div>
  );
}

interface MessagePartRendererProps {
  part: MessagePart;
}

function MessagePartRenderer({ part }: MessagePartRendererProps) {
  if (part.type === "text") {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 text-sm">
        <ReactMarkdown>{part.text}</ReactMarkdown>
      </div>
    );
  }

  if (part.type === "tool") {
    return <ToolCallBadge toolCall={part.toolCall} />;
  }

  return null;
}

interface ToolCallBadgeProps {
  toolCall: ToolCall;
}

function ToolCallBadge({ toolCall }: ToolCallBadgeProps) {
  const t = useTranslations("chat");
  const { uiActions } = useChat();
  const { renderToolResult, hasRenderer } = useToolResultRenderer({
    uiActions: {
      scrollToTransaction: uiActions.scrollToTransaction,
      openTransactionSheet: uiActions.openTransactionSheet,
      openFile: uiActions.openFile,
    },
  });

  const statusIcons = {
    pending: <Loader2 className="h-3 w-3 animate-spin" />,
    approved: <CheckCircle className="h-3 w-3 text-green-500" />,
    rejected: <XCircle className="h-3 w-3 text-red-500" />,
    executed: <CheckCircle className="h-3 w-3 text-green-500" />,
  };

  // Format tool name for display
  const formatToolName = (name: string) => {
    return name
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (str) => str.toUpperCase())
      .trim();
  };

  // Render result preview if available
  const resultPreview = toolCall.status === "executed" && hasRenderer(toolCall.name)
    ? renderToolResult(toolCall)
    : null;

  if (toolCall.status === "executed") {
    if (resultPreview) {
      return <div className="flex flex-col gap-2">{resultPreview}</div>;
    }

    if (toolResultFailed(toolCall.result)) {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <XCircle className="h-3.5 w-3.5 text-red-500" />
          <span>{t("toolFailed", { tool: formatToolName(toolCall.name) })}</span>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle className="h-3.5 w-3.5 text-green-500" />
        <span>{t("toolCompleted", { tool: formatToolName(toolCall.name) })}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Badge
        variant="muted"
        className="flex items-center gap-1 text-xs w-fit text-muted-foreground"
      >
        <Wrench className="h-3 w-3" />
        {formatToolName(toolCall.name)}
        {statusIcons[toolCall.status]}
      </Badge>

      {/* GenUI result preview from design system */}
      {resultPreview}
    </div>
  );
}

/**
 * A tool that ran but did nothing: an error, or `success: false` (a bulk update
 * whose every row failed). Results arrive as objects or as JSON strings.
 */
function toolResultFailed(result: unknown): boolean {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object") return false;
  const r = value as { success?: unknown; error?: unknown };
  return r.success === false || (typeof r.error === "string" && r.error.length > 0);
}
