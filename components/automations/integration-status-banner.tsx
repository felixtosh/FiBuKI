"use client";

import { AlertCircle, ExternalLink, RefreshCw, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";

export type IntegrationType = "gmail" | "outlook" | "browser";

export interface IntegrationStatusInfo {
  id: IntegrationType;
  displayName: string;
  isConnected: boolean;
  needsReauth: boolean;
  isPaused?: boolean;
  integrationId?: string; // For specific integration instance
}

interface IntegrationStatusBannerProps {
  integration: IntegrationStatusInfo;
  variant?: "compact" | "full";
  onReconnect?: () => void;
  className?: string;
}

/**
 * Reusable banner component for showing integration connection status.
 * Shows warnings when an integration is not connected, needs reauth, or is paused.
 */
export function IntegrationStatusBanner({
  integration,
  variant = "full",
  onReconnect,
  className,
}: IntegrationStatusBannerProps) {
  const { id, displayName, isConnected, needsReauth, isPaused, integrationId } = integration;

  // Don't show if everything is fine
  if (isConnected && !needsReauth && !isPaused) {
    return null;
  }

  const getIntegrationUrl = () => {
    if (id === "browser") {
      return "/integrations/browser";
    }
    if (integrationId) {
      return `/integrations/${integrationId}`;
    }
    return "/settings/integrations";
  };

  const getMessage = () => {
    if (isPaused) {
      return `${displayName} sync is paused`;
    }
    if (needsReauth) {
      return `${displayName} needs to be reconnected`;
    }
    return `${displayName} is not connected`;
  };

  const getDescription = () => {
    if (id === "browser") {
      return isPaused
        ? "Resume the browser extension to enable automated invoice collection."
        : "Install the browser extension to automatically collect invoices from partner websites.";
    }
    if (isPaused) {
      return "Resume syncing to enable this automation.";
    }
    if (needsReauth) {
      return "Your access has expired. Reconnect to continue using this automation.";
    }
    return "Connect this integration to enable automated file searching.";
  };

  const getActionLabel = () => {
    if (id === "browser" && !isConnected) {
      return "Install Extension";
    }
    if (isPaused) {
      return "Resume";
    }
    if (needsReauth) {
      return "Reconnect";
    }
    return "Connect";
  };

  const ActionIcon = isPaused ? RefreshCw : needsReauth ? RefreshCw : id === "browser" ? Plug : ExternalLink;

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400",
          className
        )}
      >
        <AlertCircle className="h-3 w-3 flex-shrink-0" />
        <span className="truncate">{getMessage()}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-2 text-xs text-amber-600 hover:text-amber-700"
          asChild
        >
          <Link href={getIntegrationUrl()}>
            {getActionLabel()}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800",
        className
      )}
    >
      <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {getMessage()}
        </p>
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
          {getDescription()}
        </p>
      </div>
      {onReconnect ? (
        <Button
          size="sm"
          variant="outline"
          onClick={onReconnect}
          className="flex-shrink-0 border-amber-300 text-amber-700 hover:bg-amber-100"
        >
          <ActionIcon className="h-4 w-4 mr-1" />
          {getActionLabel()}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          asChild
          className="flex-shrink-0 border-amber-300 text-amber-700 hover:bg-amber-100"
        >
          <Link href={getIntegrationUrl()}>
            <ActionIcon className="h-4 w-4 mr-1" />
            {getActionLabel()}
          </Link>
        </Button>
      )}
    </div>
  );
}

/**
 * Show multiple integration status banners stacked
 */
interface MultipleIntegrationStatusProps {
  integrations: IntegrationStatusInfo[];
  variant?: "compact" | "full";
  className?: string;
}

export function MultipleIntegrationStatus({
  integrations,
  variant = "full",
  className,
}: MultipleIntegrationStatusProps) {
  // Filter to only show integrations that need attention
  const needsAttention = integrations.filter(
    (i) => !i.isConnected || i.needsReauth || i.isPaused
  );

  if (needsAttention.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {needsAttention.map((integration) => (
        <IntegrationStatusBanner
          key={integration.id}
          integration={integration}
          variant={variant}
        />
      ))}
    </div>
  );
}
