"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useSources } from "@/hooks/use-sources";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Upload,
  Building2,
  CreditCard,
  Calendar,
  Trash2,
  Loader2,
  Link2,
  Unlink,
  RefreshCw,
  AlertTriangle,
  Globe,
} from "lucide-react";
import { useImports } from "@/hooks/use-imports";
import { ImportHistoryCard } from "@/components/sources/import-history-card";
import { DraftImportsSection } from "@/components/sources/draft-imports-section";
import { SyncStatusCard } from "@/components/sources/sync-status-card";
import { EditSourceDialog } from "@/components/sources/edit-source-dialog";
import { format } from "date-fns";
import { Pencil } from "lucide-react";
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
import { GoCardlessConnectorConfig, ApiConnectorConfig } from "@/types/source";
import { TrueLayerApiConfig } from "@/types/truelayer";
import { formatIban } from "@/lib/import/deduplication";
import { usePageTitle } from "@/hooks/use-page-title";

interface SourceDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function SourceDetailPage({ params }: SourceDetailPageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { sources, loading, deleteSource, updateSource } = useSources();
  const { imports, drafts, loading: importsLoading, deleteImport, deleteDraft } = useImports(id);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);

  const source = sources.find((s) => s.id === id);

  // Set page title
  usePageTitle("Accounts", source?.name);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!source) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Source not found</p>
        <Button
          variant="link"
          onClick={() => router.push("/sources")}
          className="mt-2"
        >
          Back to sources
        </Button>
      </div>
    );
  }

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteSource(source.id);
      router.push("/sources");
    } catch (error) {
      console.error("Failed to delete source:", error);
      setIsDeleting(false);
    }
  };

  const handleConnect = () => {
    router.push(`/sources/connect?sourceId=${source.id}`);
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      // Call API to disconnect and optionally delete transactions
      const response = await fetch(`/api/sources/${source.id}/disconnect`, {
        method: "POST",
      });
      const data = await response.json();
      if (response.ok) {
        console.log("Disconnected:", data);
        // The source will update via real-time listener
      } else {
        console.error("Disconnect failed:", data.error);
        alert(`Failed to disconnect: ${data.error}`);
      }
    } catch (error) {
      console.error("Failed to disconnect:", error);
      alert("Failed to disconnect");
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleSaveEdit = async (data: Partial<typeof source>) => {
    await updateSource(source.id, data);
  };

  // Check for any API connection (GoCardless or TrueLayer)
  const isApiConnected = source.type === "api" &&
    (source.apiConfig?.provider === "gocardless" || source.apiConfig?.provider === "truelayer");
  const isGoCardless = source.apiConfig?.provider === "gocardless";
  const isTrueLayer = source.apiConfig?.provider === "truelayer";

  const goCardlessConfig = isGoCardless ? source.apiConfig as unknown as GoCardlessConnectorConfig : undefined;
  const trueLayerConfig = isTrueLayer ? source.apiConfig as unknown as TrueLayerApiConfig : undefined;

  // Check if re-auth is needed (only GoCardless has expiry)
  const needsReauth = isGoCardless && goCardlessConfig?.agreementExpiresAt
    ? goCardlessConfig.agreementExpiresAt.toDate() < new Date()
    : false;

  // Days until expiry (only GoCardless)
  const daysUntilExpiry = isGoCardless && goCardlessConfig?.agreementExpiresAt
    ? Math.max(0, Math.floor((goCardlessConfig.agreementExpiresAt.toDate().getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  // Get provider name for display
  const providerName = goCardlessConfig?.institutionName || trueLayerConfig?.providerName || "Bank";
  const providerLogo = goCardlessConfig?.institutionLogo || trueLayerConfig?.providerLogo;
  const lastSyncAt = goCardlessConfig?.lastSyncAt || trueLayerConfig?.lastSyncAt;

  return (
    <div className="px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push("/sources")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10">
              {source.accountKind === "credit_card" ? (
                <CreditCard className="h-6 w-6 text-primary" />
              ) : (
                <Building2 className="h-6 w-6 text-primary" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold">{source.name}</h1>
                {isApiConnected ? (
                  <Badge
                    variant={needsReauth ? "destructive" : "outline"}
                    className={!needsReauth ? (
                      daysUntilExpiry !== null && daysUntilExpiry <= 7
                        ? "border-yellow-500 text-yellow-600"
                        : "border-green-500 text-green-600"
                    ) : ""}
                  >
                    {needsReauth ? "Reconnect Required" :
                     daysUntilExpiry !== null && daysUntilExpiry <= 7 ? "Expires Soon" : "Connected"}
                  </Badge>
                ) : (
                  <Badge variant="secondary">CSV Import</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground font-mono">
                {formatIban(source.iban)}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsEditOpen(true)}
            className="text-muted-foreground"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Bank Account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete &quot;{source.name}&quot; and all
                  associated imports. Transactions will remain but lose their source reference.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {isDeleting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {isApiConnected ? (
            <>
              {/* Disconnect button */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={isDisconnecting}
                  >
                    {isDisconnecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Unlink className="h-4 w-4 mr-2" />
                    )}
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect Bank?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove the bank connection and delete all synced transactions
                      for &quot;{source.name}&quot;. CSV imports will not be affected.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDisconnect}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {/* Renew/Reconnect button (only for GoCardless) */}
              {isGoCardless && (
                <Button
                  variant={needsReauth ? "default" : "outline"}
                  size="sm"
                  onClick={handleConnect}
                >
                  {needsReauth ? (
                    <>
                      <AlertTriangle className="h-4 w-4 mr-2" />
                      Reconnect
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Renew
                    </>
                  )}
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={handleConnect}>
              <Link2 className="h-4 w-4 mr-2" />
              Connect Bank
            </Button>
          )}

          <Button size="sm" onClick={() => router.push(`/sources/${source.id}/import`)}>
            <Upload className="h-4 w-4 mr-2" />
            Import CSV
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Account Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Account Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {/* Show IBAN for bank accounts, Card info for credit cards */}
                {source.accountKind === "credit_card" ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-muted rounded-lg">
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Card Type</p>
                        <p className="font-medium capitalize">{source.cardBrand || "—"}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-muted rounded-lg">
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Last 4</p>
                        <p className="font-medium font-mono">••••{source.cardLast4 || "—"}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-muted rounded-lg">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">IBAN</p>
                      <p className="font-medium font-mono text-sm">{formatIban(source.iban)}</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-muted rounded-lg">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Currency</p>
                    <p className="font-medium">{source.currency || "EUR"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-muted rounded-lg">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Added</p>
                    <p className="font-medium">
                      {format(source.createdAt.toDate(), "MMM d, yyyy")}
                    </p>
                  </div>
                </div>
              </div>

              {/* Linked Account Section */}
              {source.accountKind === "credit_card" && source.linkedSourceId && (
                <div className="mt-4 pt-4 border-t">
                  <p className="text-sm text-muted-foreground mb-2">Bills to</p>
                  {(() => {
                    const linkedAccount = sources.find(s => s.id === source.linkedSourceId);
                    if (!linkedAccount) return <p className="text-sm text-muted-foreground italic">Linked account not found</p>;
                    return (
                      <button
                        onClick={() => router.push(`/sources/${linkedAccount.id}`)}
                        className="flex items-center gap-2 p-2 -m-2 rounded-lg hover:bg-muted transition-colors text-left"
                      >
                        <div className="p-1.5 bg-primary/10 rounded">
                          <Building2 className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="font-medium text-sm">{linkedAccount.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{formatIban(linkedAccount.iban)}</p>
                        </div>
                      </button>
                    );
                  })()}
                </div>
              )}

              {/* Show linked credit cards for bank accounts */}
              {source.accountKind === "bank_account" && (() => {
                const linkedCards = sources.filter(s => s.linkedSourceId === source.id);
                if (linkedCards.length === 0) return null;
                return (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-sm text-muted-foreground mb-2">Linked Cards</p>
                    <div className="space-y-2">
                      {linkedCards.map(card => (
                        <button
                          key={card.id}
                          onClick={() => router.push(`/sources/${card.id}`)}
                          className="flex items-center gap-2 p-2 -m-2 rounded-lg hover:bg-muted transition-colors text-left w-full"
                        >
                          <div className="p-1.5 bg-primary/10 rounded">
                            <CreditCard className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">{card.name}</p>
                            <p className="text-xs text-muted-foreground font-mono">
                              {card.cardBrand?.toUpperCase()} ••••{card.cardLast4}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* Draft Imports */}
          <DraftImportsSection
            sourceId={source.id}
            drafts={drafts}
            onDeleteDraft={deleteDraft}
            isLoading={importsLoading}
          />

          {/* Import History */}
          <ImportHistoryCard
            imports={imports}
            loading={importsLoading}
            sourceId={source.id}
            onDeleteImport={deleteImport}
          />

          {/* Saved Mappings */}
          {source.fieldMappings && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Saved Column Mappings</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {Object.entries(source.fieldMappings.mappings).map(
                    ([csvColumn, targetField]) => (
                      <div
                        key={csvColumn}
                        className="flex items-center gap-2 text-sm p-2 bg-muted rounded"
                      >
                        <span className="truncate text-muted-foreground">{csvColumn}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-medium truncate">{targetField}</span>
                      </div>
                    )
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Only show for API connected accounts */}
        {isApiConnected && (
          <div className="space-y-6">
            <SyncStatusCard sourceId={source.id} onReauth={handleConnect} />

            {/* Connection Details */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Connection Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {providerLogo && (
                  <div className="flex items-center gap-3 pb-3 border-b">
                    <img
                      src={providerLogo}
                      alt={providerName}
                      className="h-8 w-8 rounded"
                    />
                    <span className="font-medium">{providerName}</span>
                  </div>
                )}
                {!providerLogo && providerName && (
                  <div className="flex items-center gap-3 pb-3 border-b">
                    <div className="h-8 w-8 rounded bg-muted flex items-center justify-center">
                      <Building2 className="h-4 w-4" />
                    </div>
                    <span className="font-medium">{providerName}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="font-medium capitalize">
                    {isTrueLayer ? "TrueLayer" : isGoCardless ? "GoCardless" : "API"}
                  </span>
                </div>
                {isGoCardless && goCardlessConfig?.agreementExpiresAt && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Valid Until</span>
                    <span className="font-medium">
                      {format(goCardlessConfig.agreementExpiresAt.toDate(), "MMM d, yyyy")}
                    </span>
                  </div>
                )}
                {isTrueLayer && trueLayerConfig?.connectedAt && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Connected</span>
                    <span className="font-medium">
                      {format(trueLayerConfig.connectedAt.toDate(), "MMM d, yyyy")}
                    </span>
                  </div>
                )}
                {lastSyncAt && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Last Sync</span>
                    <span className="font-medium">
                      {format(lastSyncAt.toDate(), "MMM d, HH:mm")}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <EditSourceDialog
        open={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onSave={handleSaveEdit}
        source={source}
        sources={sources}
      />
    </div>
  );
}
