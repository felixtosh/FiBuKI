"use client";

import Link from "next/link";
import { FileText, FolderSearch, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { LocalFilesSearchResult, LocalFileCandidate, ToolResultUIActions } from "./types";
import { ScoreBadge, RejectedBadge } from "./classification-badges";

// Note: strategy field is available but not displayed in header to save space

interface LocalFilesResultProps {
  result: LocalFilesSearchResult;
  uiActions?: ToolResultUIActions;
  maxItems?: number;
}

/**
 * GenUI preview for searchLocalFiles tool results.
 * Shows a compact list of matching local files with scores.
 */
export function LocalFilesResult({
  result,
  uiActions,
  maxItems = 5,
}: LocalFilesResultProps) {
  const { candidates, totalFound } = result;
  const displayCandidates = candidates.slice(0, maxItems);
  const hasMore = totalFound > maxItems;

  const handleRowClick = (candidate: LocalFileCandidate) => {
    if (candidate.fileId && uiActions?.openFile) {
      uiActions.openFile(candidate.fileId);
    }
  };

  /** Format an amount for display. The tool reports integer cents (#616). */
  const formatAmount = (amountCents: number, currency?: string) => {
    const currencyCode = currency || "EUR";
    return (amountCents / 100).toLocaleString("de-DE", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  if (candidates.length === 0) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground flex items-center gap-2">
        <FolderSearch className="h-4 w-4" />
        <span>No matching local files found</span>
      </div>
    );
  }

  return (
    <div className="rounded-md border text-xs overflow-hidden">
      {/* Table header row */}
      <div className="bg-muted/50 grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1.5 border-b items-center">
        <span className="font-medium text-muted-foreground">Name</span>
        <span className="font-medium text-muted-foreground text-right w-[70px]">Amount</span>
        <span className="font-medium text-muted-foreground text-right w-[50px]">Match</span>
      </div>

      {/* Results list - table rows */}
      <div className="divide-y divide-muted/50">
        {displayCandidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => handleRowClick(candidate)}
            className="w-full grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-2 hover:bg-muted/50 transition-colors text-left items-center"
          >
            {/* Filename with icon */}
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium truncate">
                {candidate.fileName || "Unnamed file"}
              </span>
            </div>

            {/* Extracted amount */}
            <span className={cn(
              "text-right tabular-nums w-[70px]",
              candidate.extractedAmount
                ? (candidate.extractedAmount < 0 ? "text-amount-negative" : "text-amount-positive")
                : "text-muted-foreground"
            )}>
              {candidate.extractedAmount ? formatAmount(candidate.extractedAmount, candidate.extractedCurrency) : "—"}
            </span>

            {/* Score badge with tooltip - show "Rejected" if rejected */}
            <div className="w-[50px] flex justify-center">
              {candidate.isRejected ? (
                <RejectedBadge size="sm" />
              ) : (
                <ScoreBadge
                  score={candidate.score}
                  size="sm"
                  showTooltip
                  tooltipReasons={candidate.scoreReasons}
                />
              )}
            </div>
          </button>
        ))}
      </div>

      {/* More indicator - links to files page with unconnected filter */}
      {hasMore && (
        <Link
          href="/files?connected=false"
          className="block px-3 py-1.5 text-center text-muted-foreground bg-muted/30 border-t hover:bg-muted/50 hover:text-foreground transition-colors group"
        >
          <span className="flex items-center justify-center gap-1">
            +{totalFound - maxItems} more files
            <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
          </span>
        </Link>
      )}
    </div>
  );
}
