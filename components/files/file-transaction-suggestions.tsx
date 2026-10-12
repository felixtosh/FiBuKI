"use client";

import { useState, useMemo, useCallback } from "react";
import { format } from "date-fns";
import { Check, X, Loader2, Calendar, Euro, Building2, CreditCard, Hash, Sparkles } from "lucide-react";
import { TaxFile, TransactionSuggestion, TransactionMatchSource } from "@/types/file";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getTransactionMatchConfidenceColor,
  getTransactionMatchSourceLabel,
} from "@/lib/matching/transaction-matcher";

function formatAmount(amount: number, currency: string = "EUR") {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency || "EUR",
  }).format(amount / 100);
}

function getSourceIcon(source: TransactionMatchSource) {
  switch (source) {
    case "amount_exact":
    case "amount_close":
      return Euro;
    case "date_exact":
    case "date_close":
      return Calendar;
    case "partner":
      return Building2;
    case "iban":
      return CreditCard;
    case "reference":
      return Hash;
    default:
      return Check;
  }
}

interface SuggestionRowProps {
  suggestion: TransactionSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
  disabled?: boolean;
  exitState?: "accepting" | "dismissing";
}

function SuggestionRow({
  suggestion,
  onAccept,
  onDismiss,
  disabled,
  exitState,
}: SuggestionRowProps) {
  const { preview, confidence, matchSources } = suggestion;

  return (
    <div
      className={cn(
        "flex items-center gap-2 p-2 -mx-2 rounded bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30",
        exitState === "accepting" && "animate-suggestion-accept",
        exitState === "dismissing" && "animate-suggestion-dismiss"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm truncate flex-1">{preview.name}</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 text-xs px-1.5 py-0 cursor-help",
                  getTransactionMatchConfidenceColor(confidence)
                )}
              >
                {confidence}%
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[220px] text-xs">
              <div className="font-medium mb-1">Match signals</div>
              {matchSources.length > 0 ? (
                <div className="space-y-0.5">
                  {matchSources.map((source, idx) => (
                    <div key={idx}>{getTransactionMatchSourceLabel(source)}</div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">No specific signals</div>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-muted-foreground">
            {preview.date?.toDate
              ? format(preview.date.toDate(), "MMM d, yyyy")
              : ""}
          </p>
          <span
            className={cn(
              "text-sm font-medium tabular-nums",
              preview.amount < 0 ? "text-amount-negative" : "text-amount-positive"
            )}
          >
            {formatAmount(preview.amount, preview.currency)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onDismiss}
          disabled={disabled || !!exitState}
          className="p-1 rounded hover:bg-destructive/10 transition-colors"
          title="Dismiss suggestion"
        >
          <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={disabled || !!exitState}
          className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
          title="Connect transaction"
        >
          <Check className="h-4 w-4 text-muted-foreground hover:text-green-600" />
        </button>
      </div>
    </div>
  );
}

interface FileTransactionSuggestionsProps {
  file: TaxFile;
  onAccept: (suggestion: TransactionSuggestion) => Promise<void>;
  onDismiss: (transactionId: string) => Promise<void>;
}

export function FileTransactionSuggestions({
  file,
  onAccept,
  onDismiss,
}: FileTransactionSuggestionsProps) {
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [exitingIds, setExitingIds] = useState<Map<string, "accepting" | "dismissing">>(new Map());
  const [badgeBump, setBadgeBump] = useState(false);

  // Filter out suggestions for already connected transactions and exiting ones
  const suggestions = useMemo(() => {
    const connectedIds = new Set(file.transactionIds || []);
    return (file.transactionSuggestions || []).filter(
      (s) => !connectedIds.has(s.transactionId)
    );
  }, [file.transactionSuggestions, file.transactionIds]);

  // Visible count excludes exiting suggestions
  const visibleCount = suggestions.filter((s) => !exitingIds.has(s.transactionId)).length;

  const triggerBadgeBump = useCallback(() => {
    setBadgeBump(true);
    const timer = setTimeout(() => setBadgeBump(false), 300);
    return () => clearTimeout(timer);
  }, []);

  const handleAccept = useCallback(async (suggestion: TransactionSuggestion) => {
    const id = suggestion.transactionId;
    setExitingIds((prev) => new Map(prev).set(id, "accepting"));
    triggerBadgeBump();

    // Fire the accept action (don't wait for animation)
    setProcessingId(id);
    try {
      await onAccept(suggestion);
    } finally {
      setProcessingId(null);
    }

    // Clean up after animation completes
    setTimeout(() => {
      setExitingIds((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }, 500);
  }, [onAccept, triggerBadgeBump]);

  const handleDismiss = useCallback(async (transactionId: string) => {
    setExitingIds((prev) => new Map(prev).set(transactionId, "dismissing"));
    triggerBadgeBump();

    setProcessingId(transactionId);
    try {
      await onDismiss(transactionId);
    } finally {
      setProcessingId(null);
    }

    // Clean up after animation completes
    setTimeout(() => {
      setExitingIds((prev) => {
        const next = new Map(prev);
        next.delete(transactionId);
        return next;
      });
    }, 350);
  }, [onDismiss, triggerBadgeBump]);

  // Don't show section if no suggestions
  if (suggestions.length === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <h3 className="text-sm font-semibold">Suggested Transactions</h3>
          <Badge
            variant="secondary"
            className={cn("text-xs", badgeBump && "animate-counter-bump")}
          >
            {visibleCount}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          These transactions may match this file based on amount, date, and partner.
        </p>

        <div className="space-y-2">
          {suggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.transactionId}
              suggestion={suggestion}
              onAccept={() => handleAccept(suggestion)}
              onDismiss={() => handleDismiss(suggestion.transactionId)}
              disabled={processingId === suggestion.transactionId}
              exitState={exitingIds.get(suggestion.transactionId)}
            />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
