"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Check, Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useChat } from "./chat-provider";
import type { OpenChoice } from "@/types/chat";

interface ChoiceOptionView {
  id: string;
  label: string;
  detail?: string;
  navigate?: string;
}

/** What presentChoices answered (lib/agent/choices.ts), as the card reads it. */
export interface PresentedChoicesView {
  status: "awaiting_choice";
  question: string;
  options: ChoiceOptionView[];
  token?: string;
}

/** What a held write answered. */
export interface AwaitingConfirmationView {
  status: "awaiting_confirmation";
  tool: string;
  args: Record<string, unknown>;
  token: string;
}

const NONE = "none";

const FEEDBACK_FIELD = "w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm";

/** The card's header: its question, and in the dock an X that puts it aside. */
function CardHeader({ title, token, docked }: { title: string; token?: string; docked?: boolean }) {
  const t = useTranslations("chat");
  const { dismissChoice } = useChat();
  return (
    <div className="flex items-start justify-between gap-2">
      <p className="font-medium">{title}</p>
      {docked && token ? (
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-1 h-6 w-6 shrink-0 text-muted-foreground"
          aria-label={t("choiceDismiss")}
          title={t("choiceDismiss")}
          onClick={() => dismissChoice(token)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

/** The dock's free reply: sent as the given option, with the text as the User's words. */
function ReplyField({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const t = useTranslations("chat");
  const [text, setText] = useState("");
  const send = () => {
    const value = text.trim();
    if (value) onSend(value);
  };
  return (
    <div className="flex items-end gap-1.5">
      <textarea
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={t("choiceReplyPlaceholder")}
        rows={1}
        className={FEEDBACK_FIELD}
      />
      <Button size="icon" className="h-9 w-9 shrink-0" disabled={disabled || !text.trim()} onClick={send} aria-label={t("choiceSend")}>
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * BuKI's options: one click runs the write the option stands for, a page
 * option opens that page, and "None of these" sends what was wrong. Docked,
 * it stands in for the chat input until it is answered or put aside.
 */
export function ChoiceCard({ choices, docked }: { choices: PresentedChoicesView; docked?: boolean }) {
  const t = useTranslations("chat");
  const router = useRouter();
  const { chooseOption, answeredChoices, isLoading } = useChat();
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const token = choices.token;
  const answered = token ? answeredChoices.get(token) : undefined;
  const disabled = !token || !!answered || isLoading;

  const choose = (option: ChoiceOptionView) => {
    if (option.navigate) {
      router.push(option.navigate);
      return;
    }
    if (token) void chooseOption({ token, optionId: option.id, label: option.label });
  };

  const sendNone = () => {
    if (!token) return;
    void chooseOption({ token, optionId: NONE, label: t("choiceNone"), feedback: feedback.trim() || undefined });
  };

  const reply = (text: string) => {
    if (token) void chooseOption({ token, optionId: NONE, label: text, feedback: text });
  };

  return (
    <Card className={cn("flex flex-col gap-2 p-3 text-sm", docked && "max-h-[60vh] overflow-y-auto shadow-md")}>
      <CardHeader title={choices.question} token={token} docked={docked} />
      <div className="flex flex-col gap-1.5">
        {choices.options.map((option) => (
          <Button
            key={option.id}
            variant="outline"
            disabled={disabled && !option.navigate}
            onClick={() => choose(option)}
            className={cn(
              "h-auto w-full flex-col items-start whitespace-normal px-3 py-2 text-left",
              answered === option.id && "border-primary bg-primary/5"
            )}
          >
            <span className="flex items-center gap-1.5 font-medium">
              {answered === option.id ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              {option.label}
            </span>
            {option.detail ? <span className="text-xs font-normal text-muted-foreground">{option.detail}</span> : null}
          </Button>
        ))}
      </div>
      {docked ? <ReplyField onSend={reply} disabled={disabled} /> : null}
      {!docked && showFeedback && !disabled ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t("choiceFeedbackPlaceholder")}
            rows={2}
            className={FEEDBACK_FIELD}
          />
          <Button size="sm" variant="secondary" onClick={sendNone} className="self-end">
            {t("choiceSend")}
          </Button>
        </div>
      ) : null}
      {!docked && !(showFeedback && !disabled) ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setShowFeedback(true)}
          className={cn("self-start text-muted-foreground", answered === NONE && "text-primary")}
        >
          {answered === NONE ? <Check className="mr-1 h-3.5 w-3.5" /> : null}
          {t("choiceNone")}
        </Button>
      ) : null}
    </Card>
  );
}

/** A big or hard-to-undo write BuKI proposed: it runs only on Approve. */
export function ConfirmCard({ pending, docked }: { pending: AwaitingConfirmationView; docked?: boolean }) {
  const t = useTranslations("chat");
  const { chooseOption, answeredChoices, isLoading } = useChat();
  const answered = answeredChoices.get(pending.token);
  const disabled = !!answered || isLoading;
  const ids = pending.args.transactionIds;
  const title = t(`confirmTitle.${pending.tool}` as "confirmTitle.bulkUpdateTransactions", {
    count: Array.isArray(ids) ? ids.length : 1,
    name: String(pending.args.name ?? ""),
  });
  const answer = (optionId: "approve" | "reject") =>
    void chooseOption({
      token: pending.token,
      optionId,
      label: optionId === "approve" ? t("confirmApprove") : t("confirmCancel"),
    });
  const reply = (text: string) => void chooseOption({ token: pending.token, optionId: "reject", label: text, feedback: text });

  return (
    <Card className={cn("flex flex-col gap-2 p-3 text-sm", docked && "shadow-md")}>
      <CardHeader title={title} token={pending.token} docked={docked} />
      <div className="flex gap-2">
        <Button size="sm" disabled={disabled} onClick={() => answer("approve")}>
          {answered === "approve" ? <Check className="mr-1 h-3.5 w-3.5" /> : null}
          {t("confirmApprove")}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => answer("reject")}>
          {answered === "reject" ? <Check className="mr-1 h-3.5 w-3.5" /> : null}
          {t("confirmCancel")}
        </Button>
      </div>
      {docked ? <ReplyField onSend={reply} disabled={disabled} /> : null}
    </Card>
  );
}

/** The open card, docked where the chat input is. */
export function DockedChoice({ choice }: { choice: OpenChoice }) {
  if (choice.result.status === "awaiting_confirmation") {
    return <ConfirmCard pending={choice.result as unknown as AwaitingConfirmationView} docked />;
  }
  return <ChoiceCard choices={choice.result as unknown as PresentedChoicesView} docked />;
}

/** Thumbs on one reply, with an optional note on a thumbs down. Stored on the turn's trace. */
export function TurnRating({ turnId }: { turnId: string }) {
  const t = useTranslations("chat");
  const { rateTurn, turnRatings } = useChat();
  const rated = turnRatings.get(turnId);
  const [askWhy, setAskWhy] = useState(false);
  const [comment, setComment] = useState("");

  const sendDown = () => {
    void rateTurn(turnId, "down", comment.trim() || undefined);
    setAskWhy(false);
  };

  if (rated && !askWhy) {
    return <span className="text-xs text-muted-foreground">{t("rateThanks")}</span>;
  }
  if (askWhy) {
    return (
      <div className="flex flex-col gap-1.5">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={t("rateCommentPlaceholder")}
          rows={2}
          className={FEEDBACK_FIELD}
        />
        <Button size="sm" variant="secondary" className="self-end" onClick={sendDown}>
          {t("choiceSend")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex gap-1 text-muted-foreground">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        aria-label={t("rateUp")}
        title={t("rateUp")}
        onClick={() => void rateTurn(turnId, "up")}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        aria-label={t("rateDown")}
        title={t("rateDown")}
        onClick={() => setAskWhy(true)}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
