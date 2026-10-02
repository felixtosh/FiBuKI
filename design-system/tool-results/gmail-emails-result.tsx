"use client";

import { Mail, AlertCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SearchedQueries } from "./searched-queries";
import { IntegrationStatusBanner } from "@/components/automations/integration-status-banner";
import { GmailEmailsSearchResult } from "./types";
import { ClassificationBadges } from "./classification-badges";

interface GmailEmailsResultProps {
  result: GmailEmailsSearchResult;
  maxItems?: number;
}

/**
 * GenUI preview for searchGmailEmails tool results.
 * Shows a compact list of matching Gmail emails with classification badges.
 */
export function GmailEmailsResult({
  result,
  maxItems = 5,
}: GmailEmailsResultProps) {
  const { emails, totalFound, query, integrationCount } = result;
  const displayEmails = emails.slice(0, maxItems);
  const hasMore = totalFound > maxItems;

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return date.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  };

  const truncateSender = (from: string, fromName?: string | null) => {
    if (fromName) return fromName.length > 20 ? fromName.slice(0, 17) + "..." : fromName;
    // Extract email part
    const emailMatch = from.match(/<([^>]+)>/);
    const email = emailMatch ? emailMatch[1] : from;
    return email.length > 20 ? email.slice(0, 17) + "..." : email;
  };

  // Show connect banner when Gmail is not connected
  if (result.gmailNotConnected) {
    return (
      <div className="rounded-md border text-xs overflow-hidden">
        {/* Header */}
        <div className="bg-muted/50 px-3 py-2 flex items-center justify-between border-b">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-sm">Gmail Emails</span>
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

  if (emails.length === 0) {
    return (
      <div className="rounded-md border text-xs overflow-hidden">
        {/* Header */}
        <div className="bg-muted/50 px-3 py-2 flex items-center justify-between border-b">
          <div className="flex items-center gap-2">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-sm">Gmail Emails</span>
          </div>
          <span className="text-muted-foreground">0 found</span>
        </div>

        {/* Search query used */}
        {query && <SearchedQueries queries={[query]} />}

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
          <span>No matching emails found</span>
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
          <span className="font-medium text-sm">Gmail Emails</span>
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

      {/* Search query used */}
      {query && <SearchedQueries queries={[query]} />}

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

      {/* Results list - two-line rows with badges below */}
      <div className="divide-y divide-muted/50">
        {displayEmails.map((email) => (
          <div
            key={email.messageId}
            className="w-full px-2.5 py-1.5 space-y-1"
          >
            {/* Line 1: Icon, sender, date */}
            <div className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-medium truncate flex-1 min-w-0">
                {truncateSender(email.from, email.fromName)}
              </span>
              {email.date && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {formatDate(email.date)}
                </span>
              )}
            </div>

            {/* Line 2: Classification badges + score */}
            <ClassificationBadges
              classification={email.classification}
              scoreLabel={email.scoreLabel}
              score={email.score ?? email.classification.confidence}
              size="sm"
              className="pl-5"
            />
          </div>
        ))}
      </div>

      {/* More indicator */}
      {hasMore && (
        <div className="px-3 py-1.5 text-center text-muted-foreground bg-muted/30 border-t">
          +{totalFound - maxItems} more emails
        </div>
      )}
    </div>
  );
}
