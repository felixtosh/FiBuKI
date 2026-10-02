"use client";

import { Mail, Paperclip, Check, AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchedQueries } from "./searched-queries";
import { IntegrationStatusBanner } from "@/components/automations/integration-status-banner";
import { GmailAttachmentsSearchResult, GmailAttachmentCandidate, ToolResultUIActions } from "./types";
import { ScoreBadge } from "./classification-badges";

interface GmailAttachmentsResultProps {
  result: GmailAttachmentsSearchResult;
  uiActions?: ToolResultUIActions;
  maxItems?: number;
}

/**
 * GenUI preview for searchGmailAttachments tool results.
 * Shows a compact list of matching Gmail attachments with scores.
 */
export function GmailAttachmentsResult({
  result,
  uiActions,
  maxItems = 5,
}: GmailAttachmentsResultProps) {
  const { candidates, totalFound, queriesUsed, integrationCount } = result;
  const displayCandidates = candidates.slice(0, maxItems);
  const hasMore = totalFound > maxItems;

  const handleRowClick = (candidate: GmailAttachmentCandidate) => {
    if (candidate.existingFileId && uiActions?.openFile) {
      uiActions.openFile(candidate.existingFileId);
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return date.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  };


  const truncateEmail = (email?: string) => {
    if (!email) return null;
    // Extract name part if present (e.g., "John Doe <john@example.com>" -> "John Doe")
    const nameMatch = email.match(/^([^<]+)</);
    if (nameMatch) return nameMatch[1].trim();
    // Otherwise just return the email, truncated
    return email.length > 25 ? email.slice(0, 22) + "..." : email;
  };

  // Show connect banner when Gmail is not connected
  if (result.gmailNotConnected) {
    return (
      <div className="rounded-md border text-xs overflow-hidden">
        {/* Header */}
        <div className="bg-muted/50 px-3 py-2 flex items-center justify-between border-b">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-sm">Gmail Attachments</span>
          </div>
        </div>

        {/* Connect Gmail banner */}
        <div className="p-3">
          <IntegrationStatusBanner
            integration={{
              id: "gmail",
              displayName: "Gmail",
              isConnected: false,
              needsReauth: false,
            }}
          />
        </div>
      </div>
    );
  }

  const { integrationsNeedingReauth } = result;

  if (candidates.length === 0) {
    return (
      <div className="rounded-md border text-xs overflow-hidden">
        {/* Header */}
        <div className="bg-muted/50 px-3 py-2 flex items-center justify-between border-b">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-sm">Gmail Attachments</span>
          </div>
          <span className="text-muted-foreground">0 found</span>
        </div>

        {/* Search queries used - show even with no results */}
        <SearchedQueries queries={queriesUsed} />

        {/* Warning banner for integrations needing reauth */}
        {integrationsNeedingReauth && integrationsNeedingReauth.length > 0 && (
          <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-200 border-b flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-[11px]">Reconnect Integration</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {integrationsNeedingReauth.map((integration) => (
                  <Button
                    key={integration.integrationId}
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px] border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
                    asChild
                  >
                    <a
                      href={`/integrations/${integration.integrationId}?toggleReconnect=true`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Gmail: {integration.email}
                    </a>
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Empty state message */}
        <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
          <Mail className="h-4 w-4" />
          <span>No matching Gmail attachments found</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border text-xs overflow-hidden">
      {/* Header */}
      <div className="bg-muted/50 px-3 py-2 flex items-center justify-between border-b">
        <div className="flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-sm">Gmail Attachments</span>
          {integrationCount > 1 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
              {integrationCount} accounts
            </Badge>
          )}
        </div>
        <span className="text-muted-foreground">
          {totalFound} found
        </span>
      </div>

      {/* Search queries used */}
      <SearchedQueries queries={queriesUsed} />

      {/* Warning banner for integrations needing reauth */}
      {integrationsNeedingReauth && integrationsNeedingReauth.length > 0 && (
        <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-200 border-b flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[11px]">Reconnect Integration</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {integrationsNeedingReauth.map((integration) => (
                <Button
                  key={integration.integrationId}
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px] border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
                  asChild
                >
                  <a
                    href={`/integrations/${integration.integrationId}?toggleReconnect=true`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Gmail: {integration.email}
                  </a>
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Results list - compact single-line rows */}
      <div className="divide-y divide-muted/50">
        {displayCandidates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => handleRowClick(candidate)}
            disabled={!candidate.alreadyDownloaded}
            className={cn(
              "w-full flex items-center gap-2 px-2.5 py-1.5 transition-colors text-left",
              candidate.alreadyDownloaded
                ? "hover:bg-muted/50 cursor-pointer"
                : "cursor-default"
            )}
          >
            {/* Attachment icon - smaller */}
            {candidate.alreadyDownloaded ? (
              <Check className="h-3.5 w-3.5 text-green-600 shrink-0" />
            ) : (
              <Paperclip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}

            {/* Filename - single line */}
            <span className="text-xs font-medium truncate flex-1 min-w-0">
              {candidate.attachmentFilename || candidate.emailSubject || "Unnamed attachment"}
            </span>

            {/* Date */}
            {candidate.emailDate && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatDate(candidate.emailDate)}
              </span>
            )}

            {/* Score badge */}
            <ScoreBadge
              score={candidate.score}
              size="sm"
              showTooltip
              tooltipReasons={candidate.scoreReasons}
              className="shrink-0"
            />
          </button>
        ))}
      </div>

      {/* More indicator */}
      {hasMore && (
        <div className="px-3 py-1.5 text-center text-muted-foreground bg-muted/30 border-t">
          +{totalFound - maxItems} more attachments
        </div>
      )}
    </div>
  );
}
