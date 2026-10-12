"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Check, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useChat } from "./chat-provider";

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

/**
 * BuKI's options: one click runs the write the option stands for, a page
 * option opens that page, and "None of these" sends what was wrong.
 */
export function ChoiceCard({ choices }: { choices: PresentedChoicesView }) {
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

  return (
    <Card className="flex flex-col gap-2 p-3 text-sm">
      <p className="font-medium">{choices.question}</p>
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
      {showFeedback && !disabled ? (
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
      ) : (
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
      )}
    </Card>
  );
}

/** A big or hard-to-undo write BuKI proposed: it runs only on Approve. */
export function ConfirmCard({ pending }: { pending: AwaitingConfirmationView }) {
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

  return (
    <Card className="flex flex-col gap-2 p-3 text-sm">
      <p className="font-medium">{title}</p>
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
    </Card>
  );
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
