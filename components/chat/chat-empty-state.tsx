"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { History, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChat } from "./chat-provider";
import type { ChatSession } from "@/types/chat";

type ExampleSet =
  | "transactionSelected"
  | "transactions"
  | "fileSelected"
  | "files"
  | "partnerSelected"
  | "partners"
  | "default";

/** Which examples fit the page: the list, and whether a record is open in its panel. */
function exampleSet(pathname: string, selected: boolean): ExampleSet {
  if (pathname.startsWith("/transactions")) return selected ? "transactionSelected" : "transactions";
  if (pathname.startsWith("/files")) return selected ? "fileSelected" : "files";
  if (pathname.startsWith("/partners")) return selected ? "partnerSelected" : "partners";
  return "default";
}

/**
 * The chat before the first message: examples that fit the page the User is
 * on (one click sends it), and the latest conversations to pick up again.
 */
export function ChatEmptyState() {
  const t = useTranslations("chat.empty");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { sendMessage, sessions, loadSession } = useChat();
  const examples = t.raw(`examples.${exampleSet(pathname, !!searchParams.get("id"))}`) as string[];
  const recent = recentSessions(sessions);

  return (
    <div className="flex flex-col gap-4 py-4 text-sm">
      <p className="font-medium">{t("title")}</p>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">{t("examplesTitle")}</p>
        {examples.map((example) => (
          <Button
            key={example}
            variant="outline"
            className="h-auto justify-start gap-2 whitespace-normal px-3 py-2 text-left font-normal"
            onClick={() => void sendMessage(example)}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {example}
          </Button>
        ))}
      </div>
      {recent.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">{t("recentTitle")}</p>
          {recent.map((session) => (
            <Button
              key={session.id}
              variant="ghost"
              className="h-auto justify-start gap-2 whitespace-normal px-3 py-1.5 text-left font-normal text-muted-foreground"
              onClick={() => void loadSession(session.id)}
            >
              <History className="h-3.5 w-3.5 shrink-0" />
              <span className="line-clamp-1">{session.title || session.lastMessagePreview}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The three latest conversations that have a message. */
function recentSessions(sessions: ChatSession[]): ChatSession[] {
  return sessions.filter((s) => s.messageCount > 0).slice(0, 3);
}
