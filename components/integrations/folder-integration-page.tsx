"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { AlertCircle, ArrowLeft, Check, Cloud, Folder, Loader2, Plus, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useFolderIntegrations, type FolderChoice } from "@/hooks/use-folder-integrations";
import { usePageTitle } from "@/hooks/use-page-title";
import { toDateSafe } from "@/lib/utils";
import type { FolderIntegration, FolderProvider } from "@/types/folder-integration";

type Hook = ReturnType<typeof useFolderIntegrations>;
type MessageValues = { [name: string]: string | number };
type Translate = (key: string, values?: MessageValues) => string;

/** Dropbox keeps folders as paths, Drive as ids; "" and "root" mean the whole store. */
const ROOT = { dropbox: "", gdrive: "root" };

/** `folderIntegrations` messages with the provider's name filled in. */
function useProviderT(provider: FolderProvider): Translate {
  const t = useTranslations("folderIntegrations");
  const name = t(`providerNames.${provider}`);
  return (key, values) => t(key, { provider: name, ...values });
}

function FolderIntegrationContent({ provider }: { provider: FolderProvider }) {
  const t = useProviderT(provider);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pagePath = `/integrations/${provider}`;
  usePageTitle(t("title"));

  const hook = useFolderIntegrations(provider);
  const [connecting, setConnecting] = useState(false);
  // The callback lands here with ?success=connected or ?error=<code>; read it
  // once, then clear the URL.
  const [landing] = useState(() => ({
    connected: searchParams.get("success") === "connected",
    error: searchParams.get("error"),
  }));
  const [error, setError] = useState(landing.error ? errorText(t, landing.error) : null);
  const justConnected = landing.connected;
  // The panel unmounts once disconnected, so the outcome is shown from here.
  const [disconnectNotice, setDisconnectNotice] = useState(null as "revoked" | "notRevoked" | null);

  useEffect(() => {
    if (searchParams.get("success") || searchParams.get("error")) {
      router.replace(pagePath, { scroll: false });
    }
  }, [searchParams, router, pagePath]);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await hook.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : errorText(t, "default"));
      setConnecting(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => router.push("/settings/integrations")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-sky-100 dark:bg-sky-900/40 flex items-center justify-center">
                <Cloud className="h-5 w-5 text-sky-600 dark:text-sky-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
              </div>
            </div>
          </div>
          {hook.integrations.length > 0 ? (
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              {t("addAccount")}
            </Button>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {disconnectNotice === "notRevoked" ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{t("disconnectNotRevoked")}</AlertDescription>
          </Alert>
        ) : null}

        {disconnectNotice === "revoked" ? (
          <Alert>
            <Check className="h-4 w-4" />
            <AlertDescription>{t("disconnectRevoked")}</AlertDescription>
          </Alert>
        ) : null}

        {justConnected ? (
          <Alert>
            <Check className="h-4 w-4" />
            <AlertDescription>{t("connected")}</AlertDescription>
          </Alert>
        ) : null}

        {hook.loading ? (
          <div className="text-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" />
            {t("loading")}
          </div>
        ) : null}

        {!hook.loading && hook.integrations.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground space-y-3">
            <Cloud className="h-12 w-12 mx-auto opacity-30" />
            <p className="font-medium text-foreground">{t("emptyTitle")}</p>
            <p className="text-sm max-w-md mx-auto">{t("emptyHint")}</p>
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {t("connect")}
            </Button>
          </div>
        ) : null}

        <div className="space-y-4">
          {hook.integrations.map((integration) => (
            <IntegrationPanel
              key={integration.id}
              integration={integration}
              hook={hook}
              provider={provider}
              onReconnect={handleConnect}
              onDisconnected={(revoked) => setDisconnectNotice(revoked ? "revoked" : "notRevoked")}
              autoOpenPicker={justConnected && integration.folderPath === null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function errorText(t: Translate, code: string): string {
  const known = ["access_denied", "invalid_state", "missing_scope", "oauth_not_configured", "encryption_not_configured", "token_exchange_failed"];
  return t(`errors.${known.includes(code) ? code : "default"}`);
}

function IntegrationPanel({
  integration,
  hook,
  provider,
  onReconnect,
  onDisconnected,
  autoOpenPicker,
}: {
  integration: FolderIntegration;
  hook: Hook;
  provider: FolderProvider;
  onReconnect: () => void;
  onDisconnected: (revoked: boolean) => void;
  autoOpenPicker: boolean;
}) {
  const t = useProviderT(provider);
  const [busy, setBusy] = useState(null as "sync" | "confirm" | "folder" | null);
  const [message, setMessage] = useState(null as string | null);
  const [pickerOpen, setPickerOpen] = useState(autoOpenPicker);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const lastSync = toDateSafe(integration.lastSyncAt);

  const run = async (kind: "sync" | "confirm", approve: boolean) => {
    setBusy(kind);
    setMessage(null);
    try {
      const res = await hook.syncNow(integration.id, approve);
      setMessage(t("syncDone", { imported: res.sync.imported ?? 0 }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    try {
      const res = await hook.disconnect(integration.id);
      onDisconnected(res.revoked);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const chooseFolder = async (path: string, label: string) => {
    setPickerOpen(false);
    setBusy("folder");
    setMessage(null);
    try {
      const res = await hook.setFolder(integration.id, path, label);
      setMessage(t("syncDone", { imported: res.sync.imported ?? 0 }));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const folderText =
    integration.folderPath === null
      ? t("noFolder")
      : integration.folderPath === ROOT[provider]
        ? t("wholeStore")
        : (integration.folderLabel ?? integration.folderPath);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium truncate">{integration.accountEmail}</p>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5 min-w-0">
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{folderText}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {integration.needsReauth ? <Badge variant="destructive">{t("needsReauthTitle")}</Badge> : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPickerOpen(true)}
            disabled={busy !== null || integration.needsReauth}
          >
            {integration.folderPath === null ? t("chooseFolder") : t("changeFolder")}
          </Button>
        </div>
      </div>

      {integration.needsReauth ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("needsReauthTitle")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t("needsReauthBody")}</p>
            <Button size="sm" onClick={onReconnect}>
              {t("reconnect")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {integration.pausedReason === "removals" ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("pausedRemovalsTitle")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t("pausedRemovalsBody", { count: integration.pendingRemovals })}</p>
            <Button size="sm" variant="outline" onClick={() => run("confirm", true)} disabled={busy !== null}>
              {busy === "confirm" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {t("confirmRemovals")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {integration.pausedReason === "folderMissing" ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("folderMissingTitle")}</AlertTitle>
          <AlertDescription>{t("folderMissingBody")}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{t("imported", { count: integration.importedCount })}</span>
        {integration.unsupportedCount > 0 ? <span>{t("unsupported", { count: integration.unsupportedCount })}</span> : null}
        <span>
          {lastSync ? t("lastSync", { time: formatDistanceToNow(lastSync, { addSuffix: true }) }) : t("neverSynced")}
        </span>
      </div>

      {integration.lastError ? (
        <p className="text-xs text-destructive">{t("lastError", { message: integration.lastError })}</p>
      ) : null}

      <div className="flex items-start justify-between gap-4 rounded-md border p-3">
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-medium">{t("removeConnectedLabel")}</p>
          <p className="text-xs text-muted-foreground">{t("removeConnectedHelp")}</p>
          {integration.removeConnectedFiles ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">{t("removeConnectedWarn")}</p>
          ) : null}
        </div>
        <Switch
          checked={integration.removeConnectedFiles}
          onCheckedChange={(checked) => hook.setRemoveConnected(integration.id, checked)}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => run("sync", false)}
            disabled={busy !== null || integration.needsReauth || integration.folderPath === null}
          >
            {busy === "sync" || busy === "folder" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            {busy === "sync" || busy === "folder" ? t("syncing") : t("syncNow")}
          </Button>
          {message ? <span className="text-sm text-muted-foreground">{message}</span> : null}
        </div>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDisconnectOpen(true)}>
          {t("disconnect")}
        </Button>
      </div>

      <FolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        integrationId={integration.id}
        hook={hook}
        provider={provider}
        onChoose={chooseFolder}
      />

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("disconnectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("disconnectBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => disconnect()}>{t("disconnect")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type Crumb = { path: string; name: string };

function FolderPicker({
  open,
  onOpenChange,
  integrationId,
  hook,
  provider,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrationId: string;
  hook: Hook;
  provider: FolderProvider;
  onChoose: (path: string, label: string) => void;
}) {
  const t = useProviderT(provider);
  // The way down from the root; the last crumb is the folder being looked at.
  const [trail, setTrail] = useState([] as Crumb[]);
  const [folders, setFolders] = useState(null as FolderChoice[] | null);
  const [failed, setFailed] = useState(false);

  const here = trail.length > 0 ? trail[trail.length - 1] : null;
  const path = here ? here.path : ROOT[provider];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Reset while loading, so a slow answer never shows the previous level.
    setFolders(null);
    setFailed(false);
    hook
      .listFolders(integrationId, path)
      .then((res) => {
        if (!cancelled) setFolders(res.folders);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // hook.listFolders is stable; the hook object itself is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path, integrationId]);

  const label = here ? trailLabel(trail) : t("wholeStore");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("pickerTitle")}</DialogTitle>
          <DialogDescription>{t("pickerHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-sm">
          <Button variant="ghost" size="sm" disabled={trail.length === 0} onClick={() => setTrail(trail.slice(0, -1))}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("pickerUp")}
          </Button>
          <span className="truncate text-muted-foreground">{label}</span>
        </div>

        <div className="max-h-64 overflow-auto rounded-md border divide-y">
          {folders === null && !failed ? (
            <p className="p-3 text-sm text-muted-foreground">{t("pickerLoading")}</p>
          ) : null}
          {failed ? <p className="p-3 text-sm text-destructive">{t("pickerFailed")}</p> : null}
          {folders !== null && folders.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("pickerEmpty")}</p>
          ) : null}
          {(folders ?? []).map((folder) => (
            <button
              key={folder.path}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => setTrail([...trail, { path: folder.path, name: folder.name }])}
            >
              <Folder className="h-4 w-4 shrink-0" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
        </div>

        <Button onClick={() => onChoose(path, label)}>{t("pickerHere")}</Button>
      </DialogContent>
    </Dialog>
  );
}

function trailLabel(trail: Crumb[]): string {
  return trail.map((crumb) => crumb.name).join(" / ");
}

export function FolderIntegrationPage({ provider }: { provider: FolderProvider }) {
  return (
    <Suspense fallback={null}>
      <FolderIntegrationContent provider={provider} />
    </Suspense>
  );
}
