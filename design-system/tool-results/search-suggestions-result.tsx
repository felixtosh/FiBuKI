"use client";

import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SearchSuggestionsResultData, SearchSuggestion } from "./types";
import { cn } from "@/lib/utils";

interface SearchSuggestionsResultProps {
  result: SearchSuggestionsResultData;
}

/** Get style for suggestion type badge */
function getSuggestionTypeStyle(type: SearchSuggestion["type"]): string {
  switch (type) {
    case "invoice_number":
      return "bg-green-50 text-green-900 border-green-300 dark:bg-green-900/30 dark:text-green-300";
    case "company_name":
      return "bg-blue-50 text-blue-900 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300";
    case "email_domain":
      return "bg-purple-50 text-purple-900 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300";
    case "vat_id":
      return "bg-orange-50 text-orange-900 border-orange-300 dark:bg-orange-900/30 dark:text-orange-300";
    case "iban":
      return "bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-300";
    case "pattern":
      return "bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300";
    default:
      return "bg-stone-50 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300";
  }
}

/**
 * GenUI preview for generateSearchSuggestions tool results.
 * Shows the generated search queries with type badges.
 */
export function SearchSuggestionsResult({ result }: SearchSuggestionsResultProps) {
  const { transaction, suggestions, queries } = result;

  // Use suggestions if available, otherwise fall back to queries
  const hasTypedSuggestions = suggestions && suggestions.length > 0;
  const displayItems = hasTypedSuggestions ? suggestions : queries.map((q) => ({ query: q, type: "fallback" as const, typeLabel: "", score: 0 }));

  if (displayItems.length === 0) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground flex items-center gap-2">
        <Sparkles className="h-4 w-4" />
        <span>No search suggestions generated</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border text-xs overflow-hidden">
      {/* Header */}
      <div className="bg-muted/50 px-3 py-2 flex items-center justify-between border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-sm">Search Suggestions</span>
        </div>
        <span className="text-muted-foreground">
          {displayItems.length} queries
        </span>
      </div>

      {/* Transaction context */}
      <div className="px-3 py-1.5 bg-muted/20 border-b text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{transaction.partner || transaction.name}</span>
        {" · "}
        <span>{transaction.amountFormatted}</span>
        {" · "}
        <span>{transaction.dateFormatted}</span>
      </div>

      {/* Suggestions */}
      <div className="p-2 flex flex-wrap gap-1.5">
        {displayItems.slice(0, 3).map((item, idx) => {
          const suggestion = item as SearchSuggestion;
          const typeLabel = suggestion.typeLabel || "";

          return (
            <div
              key={idx}
              className={cn(
                "inline-flex items-stretch rounded-md text-xs font-medium overflow-hidden border",
                "bg-background border-input"
              )}
            >
              {typeLabel && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 text-[10px] font-semibold flex items-center",
                    getSuggestionTypeStyle(suggestion.type)
                  )}
                >
                  {typeLabel}
                </span>
              )}
              <span className="px-2 py-0.5 font-mono">{suggestion.query}</span>
            </div>
          );
        })}
        {displayItems.length > 3 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs text-muted-foreground bg-muted">
            and {displayItems.length - 3} more
          </span>
        )}
      </div>
    </div>
  );
}
