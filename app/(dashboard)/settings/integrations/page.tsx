"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
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
  Globe,
  Inbox,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import {
  useActiveSyncForIntegration,
  useIntegrationFileStats,
} from "@/hooks/use-integration-details";
import { useBrowserExtensionStatus } from "@/hooks/use-browser-extension";
import { useEmailInbound } from "@/hooks/use-email-inbound";
import { EmailIntegration } from "@/types/email-integration";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";
import { BmdExportSection } from "@/components/settings/bmd-export-section";
import { FinanzOnlineIntegrationCard } from "@/components/settings/finanzonline-integration-card";
import { ApiKeysSection } from "@/components/settings/api-keys-section";

function IntegrationsContent() {
  const router = useRouter();
  const extension = useBrowserExtensionStatus();
  const {
    integrations,
    loading,
    error,
    connectGmail,
    refresh,
  } = useEmailIntegrations();
  const {
    loading: inboundLoading,
    error: inboundError,
    primaryAddress,
  } = useEmailInbound();

  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);

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

  const handleCopyEmail = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (primaryAddress?.email) {
      await navigator.clipboard.writeText(primaryAddress.email);
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    }
  };

  const gmailIntegrations = integrations.filter((i) => i.provider === "gmail");
  const extensionInstalled = extension.status === "installed";

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <SettingsPageHeader
          title="Integrations"
          description="Connect external services to automatically find and match invoices"
          className="mb-0"
        />

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Browser Plugin Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                  <Globe className="h-5 w-5 text-emerald-700" />
                </div>
                <div>
                  <CardTitle className="text-lg">Browser Plugin</CardTitle>
                  <CardDescription>
                    Pull invoices from logged-in portals in Chrome
                  </CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div
              className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => router.push("/integrations/browser")}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                    <Globe className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Chrome Extension</span>
                      {extension.status === "checking" ? (
                        <Badge variant="secondary" className="text-xs border-blue-500 text-blue-600">
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          Checking
                        </Badge>
                      ) : extensionInstalled ? (
                        <Badge variant="secondary" className="text-xs border-green-500 text-green-600">
                          <Check className="h-3 w-3 mr-1" />
                          Installed
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs border-amber-500 text-amber-600">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          Not installed
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {extensionInstalled
                        ? "Extension connected and ready to pull invoices"
                        : "Install the plugin to start scanning invoice portals"}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      extension.checkNow();
                    }}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Gmail Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-red-100 flex items-center justify-center">
                  <Mail className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">Gmail</CardTitle>
                  <CardDescription>
                    Search emails for invoice attachments
                  </CardDescription>
                </div>
              </div>
              <Button
                onClick={handleConnectGmail}
                disabled={connecting}
              >
                {connecting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-2" />
                )}
                Add Account
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            {loading ? (
              <div className="text-center py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" />
                Loading integrations...
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
          </CardContent>
        </Card>

        {/* Email Forwarding Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
                  <Inbox className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">Email Forwarding</CardTitle>
                  <CardDescription>
                    Forward invoices to a dedicated email address
                  </CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {inboundLoading || !primaryAddress ? (
              <div className="text-center py-8 text-muted-foreground">
                <Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" />
                Setting up your forwarding address...
              </div>
            ) : (
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => router.push("/integrations/email-inbound")}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                      <Inbox className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <code className="font-medium text-sm bg-muted px-2 py-1 rounded">
                          {primaryAddress.email}
                        </code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={handleCopyEmail}
                        >
                          {copiedEmail ? (
                            <Check className="h-3.5 w-3.5 text-green-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        {primaryAddress.isActive ? (
                          <Badge variant="secondary" className="text-xs border-green-500 text-green-600">
                            <Check className="h-3 w-3 mr-1" />
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs border-amber-500 text-amber-600">
                            <Pause className="h-3 w-3 mr-1" />
                            Paused
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {primaryAddress.emailsReceived} emails received
                        {primaryAddress.filesCreated > 0 && ` • ${primaryAddress.filesCreated} files created`}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {primaryAddress.lastEmailAt && (
                      <div className="text-right text-xs text-muted-foreground">
                        Last email {formatDistanceToNow(primaryAddress.lastEmailAt.toDate(), { addSuffix: true })}
                      </div>
                    )}
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </div>
                </div>
              </div>
            )}

            {inboundError && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{inboundError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* BMD NTCS Export Section */}
        <BmdExportSection />

        {/* FinanzOnline WebService Section */}
        <FinanzOnlineIntegrationCard />

        {/* AI Agents Section */}
        <ApiKeysSection />

        {/* Coming Soon Section */}
        <Card className="opacity-60">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
                <Mail className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-lg">
                  Microsoft Outlook
                  <Badge variant="secondary" className="ml-2 text-xs">Coming Soon</Badge>
                </CardTitle>
                <CardDescription>
                  Connect your Outlook account for invoice search
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>
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

  const needsReauth = integration.needsReauth;
  const tokenExpiry = integration.tokenExpiresAt?.toDate();
  const isExpired = tokenExpiry && tokenExpiry < new Date();
  const isPaused = integration.isPaused;

  // Sync status from integration
  const lastSyncAt = integration.lastSyncAt?.toDate();
  const lastSyncStatus = integration.lastSyncStatus;
  const initialSyncComplete = integration.initialSyncComplete;
  const initialSyncStartedAt = integration.initialSyncStartedAt?.toDate();

  const isSyncingNow = !isPaused && (activeSync.isActive || (!initialSyncComplete && initialSyncStartedAt));
  const showReconnect = needsReauth || isExpired;

  return (
    <div
      className="rounded-lg border bg-card p-4 cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        {/* Left: Email and status */}
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
              ) : isPaused ? (
                <Badge variant="secondary" className="text-xs border-amber-500 text-amber-600">
                  <Pause className="h-3 w-3 mr-1" />
                  Paused
                </Badge>
              ) : isSyncingNow ? (
                <Badge variant="secondary" className="text-xs border-blue-500 text-blue-600">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Syncing
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs border-green-500 text-green-600">
                  <Check className="h-3 w-3 mr-1" />
                  Connected
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Connected {formatDistanceToNow(integration.createdAt.toDate(), { addSuffix: true })}
            </div>
          </div>
        </div>

        {/* Right: Stats, sync status, reconnect button, chevron */}
        <div className="flex items-center gap-4">
          {/* Reconnect Button */}
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

          {/* Stats and sync status */}
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
                  {/* Active sync */}
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
                      {/* Stats row */}
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

                      {/* Last synced */}
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

function IntegrationsFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

export default function SettingsIntegrationsPage() {
  return (
    <Suspense fallback={<IntegrationsFallback />}>
      <IntegrationsContent />
    </Suspense>
  );
}
