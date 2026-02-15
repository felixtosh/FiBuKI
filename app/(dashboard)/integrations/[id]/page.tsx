"use client";

import { use, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";
import {
  ArrowLeft,
  Mail,
  Loader2,
  Trash2,
  Download,
  RefreshCw,
  AlertCircle,
  Check,
  Calendar,
  FileText,
  FileCheck,
  FileWarning,
  Link2,
  Clock,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import {
  useSyncHistory,
  useIntegrationFileStats,
  useActiveSyncForIntegration,
} from "@/hooks/use-integration-details";
import { cn } from "@/lib/utils";

interface IntegrationDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function IntegrationDetailPage({ params }: IntegrationDetailPageProps) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { integrations, loading, disconnect, refresh, pauseSync, resumeSync } = useEmailIntegrations();
  const { history, loading: historyLoading } = useSyncHistory(id);
  const { stats, loading: statsLoading } = useIntegrationFileStats(id);
  const activeSync = useActiveSyncForIntegration(id);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncKnownInProgress, setSyncKnownInProgress] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const reconnectTriggeredRef = useRef(false);

  // Clear syncKnownInProgress when activeSync becomes inactive
  useEffect(() => {
    if (!activeSync.isActive && syncKnownInProgress) {
      // Small delay to allow UI to update smoothly
      const timer = setTimeout(() => setSyncKnownInProgress(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [activeSync.isActive, syncKnownInProgress]);

  const integration = integrations.find((i) => i.id === id);

  const handlePullFiles = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const response = await fetchWithAuth("/api/gmail/sync", {
        method: "POST",
        body: JSON.stringify({ integrationId: id }),
      });

      const data = await response.json();

      if (!response.ok) {
        // If sync is already in progress, show the indicator
        if (data.code === "SYNC_IN_PROGRESS" || data.code === "INITIAL_SYNC_PENDING") {
          setSyncKnownInProgress(true);
          // Don't show error for this - just show the sync indicator
          return;
        }
        setSyncError(data.error || "Failed to start sync");
        return;
      }

      if (data.alreadySynced) {
        setSyncError("Already up to date - no new date ranges to sync");
        return;
      }

      // Sync started successfully
      setSyncKnownInProgress(true);
    } catch {
      setSyncError("Failed to start sync");
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnect(id);
      router.push("/settings/integrations");
    } catch {
      // Error handled by hook
    } finally {
      setDisconnecting(false);
    }
  };

  const handleRefresh = async (returnTo?: string) => {
    setRefreshing(true);
    try {
      await refresh(id, returnTo);
    } catch {
      // Error handled by hook
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!integration || reconnectTriggeredRef.current) return;
    const shouldReconnect = searchParams?.get("toggleReconnect") === "true";
    if (!shouldReconnect) return;
    reconnectTriggeredRef.current = true;
    const returnTo = searchParams?.get("returnTo") || undefined;
    handleRefresh(returnTo);
  }, [integration, searchParams, handleRefresh]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!integration) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Integration not found</p>
        <Button
          variant="link"
          onClick={() => router.push("/settings/integrations")}
          className="mt-2"
        >
          Back to integrations
        </Button>
      </div>
    );
  }

  const needsReauth = integration.needsReauth;
  const isExpired = needsReauth; // Only treat as expired when refresh token is truly invalid
  const isPaused = integration.isPaused;
  const lastSyncAt = integration.lastSyncAt?.toDate();
  const lastSyncStatus = integration.lastSyncStatus;
  const lastSyncFileCount = integration.lastSyncFileCount;
  const initialSyncComplete = integration.initialSyncComplete;
  const initialSyncStartedAt = integration.initialSyncStartedAt?.toDate();
  const syncedRange = integration.syncedDateRange;
  const syncedFrom = syncedRange?.from?.toDate();
  const syncedTo = syncedRange?.to?.toDate();

  const isSyncingNow =
    !isPaused && (activeSync.isActive || syncKnownInProgress || (!initialSyncComplete && initialSyncStartedAt));

  const handlePause = async () => {
    setPausing(true);
    setSyncError(null);
    try {
      await pauseSync(id);
      setSyncKnownInProgress(false);
    } catch {
      setSyncError("Failed to pause sync");
    } finally {
      setPausing(false);
    }
  };

  const handleResume = async () => {
    setResuming(true);
    setSyncError(null);
    try {
      await resumeSync(id);
      setSyncKnownInProgress(true);
    } catch {
      setSyncError("Failed to resume sync");
    } finally {
      setResuming(false);
    }
  };

  return (
    <div className="px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/settings/integrations")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-red-100 flex items-center justify-center">
              <Mail className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold">{integration.email}</h1>
                {needsReauth || isExpired ? (
                  <Badge variant="destructive">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Reconnect Required
                  </Badge>
                ) : isPaused ? (
                  <Badge variant="warning">
                    <Pause className="h-3 w-3 mr-1" />
                    Paused
                  </Badge>
                ) : isSyncingNow ? (
                  <Badge variant="info">
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Syncing
                  </Badge>
                ) : (
                  <Badge variant="success">
                    <Check className="h-3 w-3 mr-1" />
                    Connected
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Gmail Integration · Connected {formatDistanceToNow(integration.createdAt.toDate(), { addSuffix: true })}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Resume Sync Button - when paused */}
          {isPaused && !needsReauth && !isExpired && (
            <Button
              variant="default"
              size="sm"
              onClick={handleResume}
              disabled={resuming}
            >
              {resuming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              <span className="ml-2">Resume Sync</span>
            </Button>
          )}

          {/* Pause Sync Button - when syncing */}
          {isSyncingNow && !isPaused && (
            <Button
              variant="outline"
              size="sm"
              onClick={handlePause}
              disabled={pausing}
            >
              {pausing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              <span className="ml-2">Pause Sync</span>
            </Button>
          )}

          {/* Pull New Files Button - when connected and not syncing */}
          {!needsReauth && !isExpired && !isSyncingNow && !isPaused && (
            <Button
              variant="outline"
              size="sm"
              onClick={handlePullFiles}
              disabled={syncing}
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              <span className="ml-2">Pull New Files</span>
            </Button>
          )}

          {(needsReauth || isExpired) && (
            <Button
              variant="default"
              size="sm"
              onClick={() => handleRefresh()}
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

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Gmail Account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will disconnect <strong>{integration.email}</strong> from FiBuKI.
                  You can reconnect it anytime. Files already imported will remain.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDisconnect}>
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Sync Error */}
      {syncError && (
        <div className="mb-6 p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4" />
            <span>{syncError}</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Stats & History */}
        <div className="lg:col-span-2 space-y-6">
          {/* Stats Grid */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Import Statistics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-4 rounded-lg bg-muted">
                  <FileText className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                  <div className="text-2xl font-semibold">
                    {statsLoading ? "..." : stats?.totalFilesImported || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Files Imported</div>
                </div>
                <div className="text-center p-4 rounded-lg bg-muted">
                  <FileCheck className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                  <div className="text-2xl font-semibold">
                    {statsLoading ? "..." : stats?.filesExtracted || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Extracted</div>
                </div>
                <div className="text-center p-4 rounded-lg bg-muted">
                  <Link2 className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                  <div className="text-2xl font-semibold">
                    {statsLoading ? "..." : stats?.filesMatched || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Matched</div>
                </div>
                <div className="text-center p-4 rounded-lg bg-muted">
                  <FileWarning className={cn(
                    "h-5 w-5 mx-auto mb-2",
                    (stats?.filesWithErrors || 0) > 0 ? "text-destructive" : "text-muted-foreground"
                  )} />
                  <div className={cn(
                    "text-2xl font-semibold",
                    (stats?.filesWithErrors || 0) > 0 && "text-destructive"
                  )}>
                    {statsLoading ? "..." : stats?.filesWithErrors || 0}
                  </div>
                  <div className="text-xs text-muted-foreground">Errors</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Sync History */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sync History</CardTitle>
            </CardHeader>
            <CardContent>
              {historyLoading && !isSyncingNow ? (
                <div className="text-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto" />
                </div>
              ) : history.length === 0 && !isSyncingNow ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No sync history yet</p>
                  <p className="text-sm mt-1">Sync history will appear here after your first sync completes</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Active sync shown as first item */}
                  {isSyncingNow && (
                    <div className="p-3 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="border-blue-500 text-blue-600">
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            syncing
                          </Badge>
                          <div>
                            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                              In progress...
                            </p>
                            <p className="text-xs text-blue-600 dark:text-blue-300">
                              {activeSync.filesCreated > 0
                                ? `${activeSync.filesCreated} files · ${activeSync.emailsProcessed} emails processed`
                                : "Scanning for invoices..."}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handlePause}
                          disabled={pausing}
                          className="text-blue-600 hover:text-blue-800 hover:bg-blue-100"
                        >
                          {pausing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Pause className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Completed history records */}
                  {history.map((record) => (
                    <div
                      key={record.id}
                      className={cn(
                        "p-3 rounded-lg border bg-card",
                        record.status === "paused" && "border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Badge
                            variant={
                              record.status === "completed"
                                ? "secondary"
                                : record.status === "partial"
                                ? "outline"
                                : record.status === "paused"
                                ? "outline"
                                : "destructive"
                            }
                            className={cn(
                              record.status === "paused" && "border-amber-500 text-amber-600"
                            )}
                          >
                            {record.status}
                          </Badge>
                          <div>
                            <p className="text-sm font-medium">
                              {format(record.dateFrom.toDate(), "MMM d")} - {format(record.dateTo.toDate(), "MMM d, yyyy")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {record.filesCreated} files · {record.emailsSearched} emails searched
                              {record.attachmentsSkipped > 0 && ` · ${record.attachmentsSkipped} skipped`}
                            </p>
                          </div>
                        </div>
                        <div className="text-right text-sm text-muted-foreground">
                          <p>{Math.round(record.durationSeconds / 60)}m</p>
                          <p className="text-xs">
                            {formatDistanceToNow(record.completedAt.toDate(), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                      {/* Show errors if any */}
                      {record.errors && record.errors.length > 0 && (
                        <div className="mt-2 pt-2 border-t">
                          <p className="text-xs font-medium text-destructive mb-1">
                            {record.errors.length} error{record.errors.length > 1 ? "s" : ""}:
                          </p>
                          <ul className="text-xs text-muted-foreground space-y-0.5 max-h-20 overflow-y-auto">
                            {record.errors.slice(0, 5).map((error, idx) => (
                              <li key={idx} className="truncate">• {error}</li>
                            ))}
                            {record.errors.length > 5 && (
                              <li className="text-muted-foreground/60">
                                ...and {record.errors.length - 5} more
                              </li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Connection Details */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Connection Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Provider</span>
                <span className="font-medium">Gmail</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span className={cn(
                  "font-medium",
                  needsReauth || isExpired ? "text-destructive" : isPaused ? "text-amber-600" : "text-green-600"
                )}>
                  {needsReauth || isExpired ? "Needs Reconnection" : isPaused ? "Paused" : "Active"}
                </span>
              </div>
              {lastSyncAt && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Last Sync</span>
                  <span className="font-medium">
                    {format(lastSyncAt, "MMM d, HH:mm")}
                  </span>
                </div>
              )}
              {lastSyncFileCount !== undefined && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Last Sync Files</span>
                  <span className="font-medium">{lastSyncFileCount}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Synced Date Range */}
          {syncedFrom && syncedTo && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Synced Date Range</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {format(syncedFrom, "MMM d, yyyy")} - {format(syncedTo, "MMM d, yyyy")}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Invoices have been searched within this date range.
                  Import older transactions to expand the search range.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
