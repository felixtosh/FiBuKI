"use client";

import { Wrench, CheckCircle, XCircle, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { RuntimeChatMessage, MessagePart, ToolCall } from "@/types/chat";
import { Badge } from "@/components/ui/badge";
import { useChat } from "./chat-provider";
import { useToolResultRenderer } from "@/hooks/use-tool-result-renderer";
import { ChoiceCard, ConfirmCard, TurnRating, type AwaitingConfirmationView, type PresentedChoicesView } from "./choice-card";

interface MessageBubbleProps {
  message: RuntimeChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const { isLoading } = useChat();

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
        withRunStatus(message.parts).map(renderItem)
      ) : (
        // Fallback to content string
        message.content && (
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 text-sm">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )
      )}
      {message.turnId && !isLoading ? <TurnRating turnId={message.turnId} /> : null}
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
    const parsed = parseResult(toolCall.result);
    // A choice or a held write: the card is the end of BuKI's turn.
    if (parsed?.status === "awaiting_choice") {
      return <ChoiceCard choices={parsed as unknown as PresentedChoicesView} />;
    }
    if (parsed?.status === "awaiting_confirmation") {
      return <ConfirmCard pending={parsed as unknown as AwaitingConfirmationView} />;
    }
    // A call the trajectory guard refused is BuKI correcting itself, not news for the User.
    if (typeof parsed?.guard === "string") return null;

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

/** A tool result as an object; results arrive as objects or as JSON strings. */
function parseResult(result: unknown): Record<string, unknown> | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A tool that ran but did nothing: an error, or `success: false` (a bulk update
 * whose every row failed).
 */
function toolResultFailed(result: unknown): boolean {
  const value = parseResult(result);
  if (!value) return false;
  const r = value as { success?: unknown; error?: unknown };
  return r.success === false || (typeof r.error === "string" && r.error.length > 0);
}

/** What a read or search tool looks at, for the status line of a silent tool run. */
const TOOL_NOUN: { [tool: string]: NounKey } = {
  listTransactions: "transactions",
  getTransaction: "transactions",
  listFiles: "files",
  getFile: "files",
  searchLocalFiles: "files",
  waitForFileExtraction: "files",
  searchGmailAttachments: "mailboxes",
  searchGmailEmails: "mailboxes",
  analyzeEmail: "mailboxes",
  listPartners: "partners",
  getPartner: "partners",
  getPartnerReceiptHints: "partners",
  lookupCompanyInfo: "company",
  validateVatId: "company",
  findReceiptForTransaction: "receipts",
  generateSearchSuggestions: "receipts",
  listCategories: "categories",
  getQueueStatus: "queue",
  getTransactionHistory: "history",
  getCorrection: "corrections",
  getReceiptLink: "corrections",
};

type NounKey =
  | "transactions"
  | "files"
  | "mailboxes"
  | "partners"
  | "company"
  | "receipts"
  | "categories"
  | "queue"
  | "history"
  | "corrections";

type RenderItem =
  | { kind: "part"; part: MessagePart }
  | { kind: "status"; tools: string[]; running: boolean };

/**
 * The parts with a status line before each run of tool calls that BuKI began
 * without a word (docs/buki-rubric.md, Experience): whatever the model, the
 * User sees what is being looked at instead of a silent row of cards.
 */
function withRunStatus(parts: MessagePart[]): RenderItem[] {
  const out: RenderItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.type !== "tool") {
      out.push({ kind: "part", part });
      i++;
      continue;
    }
    const run: MessagePart[] = [];
    while (i < parts.length && parts[i].type === "tool") run.push(parts[i++]);
    const prev = out[out.length - 1];
    const saidSomething = prev?.kind === "part" && prev.part.type === "text" && prev.part.text.trim() !== "";
    const tools = run.map((p) => (p.type === "tool" ? p.toolCall.name : ""));
    if (!saidSomething && tools.some((name) => name in TOOL_NOUN)) {
      const running = run.some((p) => p.type === "tool" && p.toolCall.status === "pending");
      out.push({ kind: "status", tools, running });
    }
    for (const p of run) out.push({ kind: "part", part: p });
  }
  return out;
}

function renderItem(item: RenderItem, index: number) {
  if (item.kind === "status") {
    return <ToolRunStatus key={`s${index}`} tools={item.tools} running={item.running} />;
  }
  return <MessagePartRenderer key={index} part={item.part} />;
}

function ToolRunStatus({ tools, running }: { tools: string[]; running: boolean }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const nouns = [...new Set(tools.map((name) => TOOL_NOUN[name]).filter(Boolean))].map((key) => t(`toolNoun.${key}`));
  const what = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(nouns);
  return (
    <div className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
      {running ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {running ? t("working", { what }) : t("worked", { what })}
    </div>
  );
}
