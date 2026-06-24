"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Mail,
  Plus,
  AlertCircle,
  Check,
  Loader2,
  FileCheck,
  ChevronRight,
  RefreshCw,
  Pause,
  ArrowLeft,
  Info,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import {
  useActiveSyncForIntegration,
  useIntegrationFileStats,
} from "@/hooks/use-integration-details";
import { EmailIntegration } from "@/types/email-integration";
import { usePageTitle } from "@/hooks/use-page-title";

function GmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  usePageTitle("Gmail");

  const {
    integrations,
    loading,
    error,
    connectGmail,
    refresh,
  } = useEmailIntegrations();

  // Broadcast Gmail reconnection to other tabs (e.g., chat)
  useEffect(() => {
    const success = searchParams.get("success");
    if (success === "reconnected" || success === "tokens_updated" || success === "connected") {
      localStorage.setItem("gmail_reconnected", JSON.stringify({
        status: success,
        timestamp: Date.now(),
      }));
      router.replace("/integrations/gmail", { scroll: false });
    }
  }, [searchParams, router]);

  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const handleConnectGmail = async () => {
    setConnecting(true);
    try {
      await connectGmail();
    } catch {
      // Error is handled by the hook
    } finally {
      setConnecting(false);
    }
  };

  const handleRefresh = async (integrationId: string) => {
    setRefreshing(integrationId);
    try {
      await refresh(integrationId);
    } catch {
      // Error is handled by the hook
    } finally {
      setRefreshing(null);
    }
  };

  const gmailIntegrations = integrations.filter((i) => i.provider === "gmail");

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push("/settings/integrations")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-red-100 flex items-center justify-center">
                <Mail className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">Gmail</h1>
                <p className="text-sm text-muted-foreground">
                  Search emails for invoice attachments
                </p>
              </div>
            </div>
          </div>
          <Button onClick={handleConnectGmail} disabled={connecting}>
            {connecting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-2" />
            )}
            Add Account
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" />
            Loading accounts...
          </div>
        ) : gmailIntegrations.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Mail className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No Gmail accounts connected</p>
            <p className="text-xs mt-1">
              Click &quot;Add Account&quot; to connect your first Gmail account
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {gmailIntegrations.map((integration) => (
              <GmailAccountCard
                key={integration.id}
                integration={integration}
                onClick={() => router.push(`/integrations/${integration.id}`)}
                onRefresh={() => handleRefresh(integration.id)}
                refreshing={refreshing === integration.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface GmailAccountCardProps {
  integration: EmailIntegration;
  onClick: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

function GmailAccountCard({
  integration,
  onClick,
  onRefresh,
  refreshing,
}: GmailAccountCardProps) {
  const activeSync = useActiveSyncForIntegration(integration.id);
  const { stats, loading: statsLoading } = useIntegrationFileStats(integration.id);
  // Capture "now" once per mount so derived staleness checks stay pure.
  const [now] = useState(() => Date.now());

  const needsReauth = integration.needsReauth;
  const isPaused = integration.isPaused;

  const lastSyncAt = integration.lastSyncAt?.toDate();
  const lastSyncStatus = integration.lastSyncStatus;
  const initialSyncComplete = integration.initialSyncComplete;
  const initialSyncStartedAt = integration.initialSyncStartedAt?.toDate();
  const lastSyncError = integration.lastSyncError;

  // Detect an initial sync that's been "in progress" for >24h while carrying
  // a sync error — that's not actually progressing, it's stuck. Treat the same
  // as needsReauth so the user sees a Reconnect CTA instead of a forever-spin.
  const STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  const isStuckInitialSync =
    !initialSyncComplete &&
    !!initialSyncStartedAt &&
    !!lastSyncError &&
    now - initialSyncStartedAt.getTime() > STUCK_THRESHOLD_MS;

  const isSyncingNow =
    !isPaused &&
    !isStuckInitialSync &&
    (activeSync.isActive || (!initialSyncComplete && initialSyncStartedAt));
  const showReconnect = needsReauth || isStuckInitialSync;
  const isNewAndPaused = isPaused && !initialSyncComplete;

  return (
    <div
      className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
            <Mail className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{integration.email}</span>
              {showReconnect ? (
                <Badge variant="destructive" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Reconnect Required
                </Badge>
              ) : isNewAndPaused ? (
                <Badge variant="info" className="text-xs">
                  <Play className="h-3 w-3 mr-1" />
                  Ready to start
                </Badge>
              ) : isPaused ? (
                <Badge variant="warning" className="text-xs">
                  <Pause className="h-3 w-3 mr-1" />
                  Paused
                </Badge>
              ) : isSyncingNow ? (
                <Badge variant="info" className="text-xs">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Syncing
                </Badge>
              ) : (
                <Badge variant="success" className="text-xs">
                  <Check className="h-3 w-3 mr-1" />
                  Connected
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Connected {formatDistanceToNow(integration.createdAt.toDate(), { addSuffix: true })}
            </div>
            {isNewAndPaused && (
              <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 mt-1">
                <Info className="h-3 w-3 flex-shrink-0" />
                <span>New connections start paused. Click to open settings and start syncing.</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {showReconnect && (
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onRefresh();
              }}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              <span className="ml-2">Reconnect</span>
            </Button>
          )}

          {!showReconnect && (
            <>
              {isPaused ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRefresh();
                  }}
                  disabled={refreshing}
                >
                  {refreshing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              ) : (
                <div className="text-right">
                  {isSyncingNow ? (
                    <div className="flex items-center gap-2 text-sm text-blue-600">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>
                        Syncing...
                        {activeSync.filesCreated > 0 && ` (${activeSync.filesCreated} files)`}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {statsLoading ? "..." : stats?.totalFilesImported || 0}
                          </span> imported
                        </span>
                        <span className="text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {statsLoading ? "..." : stats?.filesExtracted || 0}
                          </span> extracted
                        </span>
                        <span className="text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {statsLoading ? "..." : stats?.filesMatched || 0}
                          </span> matched
                        </span>
                        {(stats?.filesWithErrors || 0) > 0 && (
                          <span className="text-destructive">
                            <span className="font-medium">
                              {stats?.filesWithErrors || 0}
                            </span> errors
                          </span>
                        )}
                      </div>

                      {initialSyncComplete && lastSyncAt && (
                        <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground mt-1">
                          <FileCheck className="h-3 w-3" />
                          <span>
                            Last synced {formatDistanceToNow(lastSyncAt, { addSuffix: true })}
                            {lastSyncStatus === "failed" && (
                              <span className="text-destructive ml-1">(failed)</span>
                            )}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

function GmailFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function GmailPage() {
  return (
    <Suspense fallback={<GmailFallback />}>
      <GmailContent />
    </Suspense>
  );
}
