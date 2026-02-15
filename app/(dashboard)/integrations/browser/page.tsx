"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { auth } from "@/lib/firebase/config";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  FileCheck,
  FileText,
  FileWarning,
  Globe,
  Loader2,
  Lock,
  Plug,
  RefreshCw,
  Building2,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBrowserExtensionStatus } from "@/hooks/use-browser-extension";
import { cn } from "@/lib/utils";
import { usePartners } from "@/hooks/use-partners";
import { BrowserRecipe } from "@/types/partner";
import Link from "next/link";

type PullStatus = "completed" | "error" | "login_required";
type PullStatusUpdate = "running" | PullStatus;

interface BrowserPullRecord {
  id: string;
  sourceId: string;
  sourceUrl: string;
  status: PullStatusUpdate;
  filesFound: number;
  filesDownloaded: number;
  startedAt: Date;
  durationSeconds: number;
  error?: string;
  foundUrls?: string[];
}

function createId(prefix: string, index: number) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${index}`;
}

// Extended recipe with partner info for display
interface PartnerBrowserRecipe extends BrowserRecipe {
  partnerId: string;
  partnerName: string;
}

export default function BrowserIntegrationPage() {
  const router = useRouter();
  const extension = useBrowserExtensionStatus();
  const { partners } = usePartners();
  const chromeStoreUrl =
    process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL ||
    "https://chromewebstore.google.com/";

  const [history, setHistory] = useState<BrowserPullRecord[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const historyStorageKey = "taxstudio.browserHistory";
  const loadingHistoryRef = useRef(false);
  const timeoutsRef = useRef<Record<string, number>>({});

  // Aggregate all browser recipes from all partners (includes bookmarks + recorded recipes)
  const allRecipes = useMemo(() => {
    const recipes: PartnerBrowserRecipe[] = [];
    for (const partner of partners) {
      if (partner.browserRecipes) {
        for (const recipe of partner.browserRecipes) {
          recipes.push({
            ...recipe,
            partnerId: partner.id,
            partnerName: partner.name,
          });
        }
      }
    }
    return recipes;
  }, [partners]);

  useEffect(() => {
    if (loadingHistoryRef.current) return;
    loadingHistoryRef.current = true;
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(historyStorageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as BrowserPullRecord[];
      if (Array.isArray(parsed)) {
        setHistory(
          parsed.map((record) => ({
            ...record,
            startedAt: new Date(record.startedAt),
          }))
        );
      }
    } catch {
      // Ignore malformed cache
    }
  }, [historyStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(historyStorageKey, JSON.stringify(history));
  }, [history, historyStorageKey]);

  const totals = useMemo(() => {
    const totalDownloads = history.reduce((sum, record) => sum + record.filesDownloaded, 0);
    const successfulRuns = history.filter((record) => record.status === "completed").length;
    const errorRuns = history.filter((record) => record.status !== "completed").length;
    const bookmarkCount = allRecipes.filter((r) => !r.recordedActions || r.recordedActions.length === 0).length;
    const recipeCount = allRecipes.length - bookmarkCount;
    return { totalDownloads, successfulRuns, errorRuns, bookmarkCount, recipeCount, totalCount: allRecipes.length };
  }, [history, allRecipes]);

  const clearRunning = () => {
    setHistory((prev) => prev.filter((record) => record.status !== "running"));
    setRunningIds(new Set());
  };

  const handleManualPull = async (recipe: PartnerBrowserRecipe) => {
    if (runningIds.has(recipe.id)) return;
    const runId = createId("run", history.length);
    const startedAt = new Date();
    setRunningIds((prev) => new Set(prev).add(recipe.id));
    setHistory((prev) => [
      {
        id: runId,
        sourceId: recipe.id,
        sourceUrl: recipe.startUrl,
        status: "running",
        filesFound: 0,
        filesDownloaded: 0,
        startedAt,
        durationSeconds: 0,
      },
      ...prev,
    ]);
    let visibleUrl = recipe.startUrl;
    try {
      const parsed = new URL(recipe.startUrl);
      parsed.hash = `ts_run=${runId}`;
      visibleUrl = parsed.toString();
    } catch {
      visibleUrl = recipe.startUrl;
    }
    const idToken = auth.currentUser
      ? await auth.currentUser.getIdToken()
      : null;
    window.open(visibleUrl, `ts_pull_${runId}`, "noopener,noreferrer");
    window.postMessage(
      {
        type: "TAXSTUDIO_VISIBLE_PULL",
        runId,
        url: recipe.startUrl,
        authToken: idToken,
      },
      "*"
    );
    const timeoutId = window.setTimeout(() => {
      setHistory((prev) =>
        prev.map((record) =>
          record.id === runId && record.status === "running"
            ? {
                ...record,
                status: "error",
                error: "No response from extension. Reload the plugin and try again.",
                durationSeconds: Math.max(
                  1,
                  Math.round((Date.now() - record.startedAt.getTime()) / 1000)
                ),
              }
            : record
        )
      );
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(recipe.id);
        return next;
      });
    }, 30000);
    timeoutsRef.current[runId] = timeoutId;
  };

  useEffect(() => {
    const handlePullEvent = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as {
        type?: string;
        runId?: string;
        status?: PullStatusUpdate;
        urls?: string[];
        foundCount?: number;
        downloadedCount?: number;
      };
      if (!data || !data.runId) return;

      if (data.type === "TAXSTUDIO_PULL_RESULTS") {
        setHistory((prev) =>
          prev.map((record) =>
            record.id === data.runId
              ? {
                  ...record,
                  filesFound: data.foundCount ?? (data.urls ? data.urls.length : record.filesFound),
                  filesDownloaded: data.downloadedCount ?? record.filesDownloaded,
                  foundUrls: data.urls ?? record.foundUrls,
                }
              : record
          )
        );
        return;
      }

      if (data.type === "TS_DEV_LOG") {
        const level = (data as { level?: "log" | "warn" | "error" }).level ?? "log";
        const message = String((data as { payload?: string }).payload ?? "");
        if (level === "error") {
          console.error("[Extractor]", message);
        } else if (level === "warn") {
          console.warn("[Extractor]", message);
        } else {
          console.log("[Extractor]", message);
        }
        return;
      }

      if (data.type !== "TAXSTUDIO_PULL_EVENT") return;
      if (data.status === "running") return;

      let sourceIdToClear: string | null = null;
      if (timeoutsRef.current[data.runId]) {
        window.clearTimeout(timeoutsRef.current[data.runId]);
        delete timeoutsRef.current[data.runId];
      }
      setHistory((prev) =>
        prev.map((record) => {
          if (record.id !== data.runId) return record;
          sourceIdToClear = record.sourceId;
          const durationSeconds = Math.max(
            1,
            Math.round((Date.now() - record.startedAt.getTime()) / 1000)
          );
          return {
            ...record,
            status: data.status || "completed",
            durationSeconds,
            error: data.status === "error" ? "Collector failed." : record.error,
          };
        })
      );
      if (sourceIdToClear) {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(sourceIdToClear as string);
          return next;
        });
      }
    };

    window.addEventListener("message", handlePullEvent);
    return () => window.removeEventListener("message", handlePullEvent);
  }, []);

  const extensionInstalled = extension.status === "installed";

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-6">
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
              <div className="h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center">
                <Globe className="h-6 w-6 text-emerald-700" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-semibold">Browser Plugin</h1>
                  {extension.status === "checking" ? (
                    <Badge variant="info">
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Checking
                    </Badge>
                  ) : extensionInstalled ? (
                    <Badge variant="success">
                      <Check className="h-3 w-3 mr-1" />
                      Installed
                    </Badge>
                  ) : (
                    <Badge variant="warning">
                      <AlertCircle className="h-3 w-3 mr-1" />
                      Not installed
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Chrome extension for pulling invoices from logged-in portals
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!extensionInstalled ? (
              <Button asChild>
                <a href={chromeStoreUrl} target="_blank" rel="noreferrer">
                  <Plug className="h-4 w-4 mr-2" />
                  Get browser plugin
                </a>
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={extension.checkNow}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Check connection
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Import Statistics</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <FileText className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                    <div className="text-2xl font-semibold">{totals.totalDownloads}</div>
                    <div className="text-xs text-muted-foreground">Files Imported</div>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <FileCheck className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                    <div className="text-2xl font-semibold">{totals.successfulRuns}</div>
                    <div className="text-xs text-muted-foreground">Successful Runs</div>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <FileWarning className={cn(
                      "h-5 w-5 mx-auto mb-2",
                      totals.errorRuns > 0 ? "text-destructive" : "text-muted-foreground"
                    )} />
                    <div className={cn(
                      "text-2xl font-semibold",
                      totals.errorRuns > 0 && "text-destructive"
                    )}>
                      {totals.errorRuns}
                    </div>
                    <div className="text-xs text-muted-foreground">Errors</div>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <Globe className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                    <div className="text-2xl font-semibold">{totals.bookmarkCount}</div>
                    <div className="text-xs text-muted-foreground">Bookmarks</div>
                  </div>
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <Bot className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
                    <div className="text-2xl font-semibold">{totals.recipeCount}</div>
                    <div className="text-xs text-muted-foreground">Recipes</div>
                  </div>
                </div>
              </CardContent>
            </Card>

          {/* Browser Automations Card — unified list of bookmarks + recipes */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Bot className="h-4 w-4" />
                Browser Automations
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {allRecipes.length}
                </Badge>
                <Button size="sm" variant="outline" asChild>
                  <Link href="/partners">
                    <Building2 className="h-4 w-4 mr-2" />
                    Manage in Partners
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {allRecipes.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No browser automations configured</p>
                  <p className="text-sm mt-1">Add sources to partners or use Learn Mode to create recipes</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {allRecipes.map((recipe) => {
                    const isBookmark = !recipe.recordedActions || recipe.recordedActions.length === 0;
                    const statusResult = recipe.lastReplayResult;
                    const recipeStatus = recipe.status || "active";
                    return (
                      <div
                        key={`${recipe.partnerId}_${recipe.id}`}
                        className={cn(
                          "rounded-lg border bg-card transition-colors hover:bg-muted/50",
                          recipeStatus === "needs_login" && "border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900",
                          recipeStatus === "error" && "border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900"
                        )}
                      >
                        <div className="flex items-center gap-3 p-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`https://www.google.com/s2/favicons?domain=${recipe.domain}&sz=32`}
                              alt=""
                              className="h-5 w-5"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                                e.currentTarget.nextElementSibling?.classList.remove("hidden");
                              }}
                            />
                            <Globe className="h-4 w-4 text-muted-foreground hidden" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">
                                {recipe.label || recipe.domain}
                              </span>
                              {isBookmark ? (
                                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0">
                                  Bookmark
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                                  {recipe.recordedActions.length} steps
                                </Badge>
                              )}
                              {recipe.requiresAuth && (
                                <Lock className="h-3 w-3 text-orange-500 flex-shrink-0" />
                              )}
                              {recipeStatus !== "active" && (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "shrink-0 text-[10px] px-1.5 py-0",
                                    recipeStatus === "paused" && "border-gray-500/50 text-gray-600",
                                    recipeStatus === "needs_login" && "border-amber-500/50 text-amber-600",
                                    recipeStatus === "error" && "border-red-500/50 text-red-600"
                                  )}
                                >
                                  {recipeStatus === "paused" && "Paused"}
                                  {recipeStatus === "needs_login" && "Login required"}
                                  {recipeStatus === "error" && "Error"}
                                </Badge>
                              )}
                              {!isBookmark && statusResult && (
                                statusResult.status === "success" ? (
                                  <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 border-green-500/50 text-green-600 bg-green-50 dark:bg-green-950/30">
                                    <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                                    Success
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 border-red-500/50 text-red-600 bg-red-50 dark:bg-red-950/30">
                                    <XCircle className="h-2.5 w-2.5 mr-0.5" />
                                    Failed
                                  </Badge>
                                )
                              )}
                              {!isBookmark && recipe.autoRun && (
                                <span className="flex items-center gap-0.5 text-[10px] text-green-600">
                                  <Zap className="h-2.5 w-2.5" />
                                  Auto
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                              <Link
                                href={`/partners?id=${recipe.partnerId}`}
                                className="text-primary hover:underline"
                              >
                                {recipe.partnerName}
                              </Link>
                              {!isBookmark && (
                                <>
                                  <span className="text-muted-foreground/50">·</span>
                                  <span>{recipe.recordedActions.length} steps</span>
                                </>
                              )}
                              {recipe.useCount > 0 && (
                                <>
                                  <span className="text-muted-foreground/50">·</span>
                                  <span>Used {recipe.useCount}x</span>
                                </>
                              )}
                              {recipe.lastUsedAt && (
                                <>
                                  <span className="text-muted-foreground/50">·</span>
                                  <span>Last: {formatDistanceToNow(recipe.lastUsedAt.toDate(), { addSuffix: true })}</span>
                                </>
                              )}
                            </div>
                            {recipe.lastError && (
                              <p className="text-[11px] text-amber-600 dark:text-amber-500 mt-1">
                                {recipe.lastError}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">Pull History</CardTitle>
              {history.some((record) => record.status === "running") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearRunning}
                >
                  Clear running
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No pull history yet</p>
                  <p className="text-sm mt-1">Runs will appear here after the plugin completes a pull</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map((record) => {
                    let recordDomain = record.sourceUrl;
                    try {
                      const parsed = new URL(record.sourceUrl);
                      recordDomain = parsed.hostname.replace(/^www\./, "");
                    } catch {
                      // Keep original
                    }
                    return (
                      <div
                        key={record.id}
                        className={cn(
                          "rounded-lg border bg-card",
                          record.status === "error" && "border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900",
                          record.status === "login_required" && "border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900"
                        )}
                      >
                        <div className="flex items-center gap-3 p-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`https://www.google.com/s2/favicons?domain=${recordDomain}&sz=32`}
                              alt=""
                              className="h-5 w-5"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                                e.currentTarget.nextElementSibling?.classList.remove("hidden");
                              }}
                            />
                            <Globe className="h-4 w-4 text-muted-foreground hidden" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{recordDomain}</span>
                              <Badge
                                variant="outline"
                                className={cn(
                                  "shrink-0 text-[10px] px-1.5 py-0",
                                  record.status === "completed" && "border-green-500/50 text-green-600 bg-green-50 dark:bg-green-950/30",
                                  record.status === "running" && "border-blue-500/50 text-blue-600 bg-blue-50 dark:bg-blue-950/30",
                                  record.status === "error" && "border-red-500/50 text-red-600 bg-red-50 dark:bg-red-950/30",
                                  record.status === "login_required" && "border-amber-500/50 text-amber-600 bg-amber-50 dark:bg-amber-950/30"
                                )}
                              >
                                {record.status === "running" ? (
                                  <span className="inline-flex items-center gap-1">
                                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                    Running
                                  </span>
                                ) : record.status === "completed" ? (
                                  "Done"
                                ) : record.status === "login_required" ? (
                                  "Login required"
                                ) : (
                                  "Error"
                                )}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                              <span>{record.filesDownloaded} downloaded</span>
                              <span className="text-muted-foreground/50">·</span>
                              <span>{record.filesFound} found</span>
                              {record.durationSeconds > 0 && (
                                <>
                                  <span className="text-muted-foreground/50">·</span>
                                  <span>{record.durationSeconds}s</span>
                                </>
                              )}
                            </div>
                            {record.error && (
                              <p className="text-[11px] text-red-600 dark:text-red-500 mt-1">
                                {record.error}
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 text-right text-xs text-muted-foreground">
                            <p className="font-medium">{format(record.startedAt, "MMM d")}</p>
                            <p>{format(record.startedAt, "HH:mm")}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Connection Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="font-medium">Chrome Extension</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Status</span>
                  <span
                    className={cn(
                      "font-medium",
                      extensionInstalled ? "text-green-600" : "text-amber-600"
                    )}
                  >
                    {extensionInstalled ? "Installed" : "Not Installed"}
                  </span>
                </div>
                {extension.version && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Version</span>
                    <span className="font-medium">{extension.version}</span>
                  </div>
                )}
                {extension.lastCheckedAt && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Last Checked</span>
                    <span className="font-medium">
                      {format(extension.lastCheckedAt, "MMM d, HH:mm")}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {!extensionInstalled && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Install Plugin</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Install the Chrome extension to enable background invoice pulls.
                    Once installed, return here and click check connection.
                  </p>
                  <Button asChild>
                    <a href={chromeStoreUrl} target="_blank" rel="noreferrer">
                      <Plug className="h-4 w-4 mr-2" />
                      Get browser plugin
                    </a>
                  </Button>
                  <Button variant="outline" onClick={extension.checkNow}>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Check connection
                  </Button>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wrench className="h-4 w-4" />
                  Developer Installation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Install the extension manually in Chrome Developer Mode to get the latest version.
                </p>

                <Button variant="outline" className="w-full" asChild>
                  <a href="/api/browser/download-extension" download>
                    <Download className="h-4 w-4 mr-2" />
                    Download Extension (.zip)
                  </a>
                </Button>

                <ol className="text-sm space-y-3 list-none">
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">1</span>
                    <span>Click the button above to download the extension zip file</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">2</span>
                    <span>Unzip the downloaded file — this creates a <code className="text-xs bg-muted px-1 py-0.5 rounded">taxstudio-browser</code> folder</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">3</span>
                    <span>Open Chrome and navigate to <code className="text-xs bg-muted px-1 py-0.5 rounded">chrome://extensions</code></span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">4</span>
                    <span>Enable <strong>Developer mode</strong> using the toggle in the top-right corner</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">5</span>
                    <span>Click <strong>Load unpacked</strong> and select the unzipped <code className="text-xs bg-muted px-1 py-0.5 rounded">taxstudio-browser</code> folder</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">6</span>
                    <span>Return here and click <strong>Check connection</strong> to verify</span>
                  </li>
                </ol>

                <p className="text-xs text-muted-foreground">
                  To update, download again and click the reload icon on the extension card in <code className="bg-muted px-1 py-0.5 rounded">chrome://extensions</code>.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
