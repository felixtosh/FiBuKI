"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useSources } from "@/hooks/use-sources";
import { useAuth } from "@/components/auth";
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
  Globe,
} from "lucide-react";
import { useImports } from "@/hooks/use-imports";
import { ImportHistoryCard } from "@/components/sources/import-history-card";
import { DraftImportsSection } from "@/components/sources/draft-imports-section";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TrueLayerApiConfig } from "@/types/truelayer";
import { formatIban } from "@/lib/import/deduplication";
import { formatCurrency } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { Wallet, Check } from "lucide-react";
import { Input } from "@/components/ui/input";

interface SourceDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function SourceDetailPage({ params }: SourceDetailPageProps) {
  const { id } = use(params);
  const router = useRouter();
  const { user } = useAuth();
  const { sources, loading, deleteSource, updateSource } = useSources();
  const { imports, drafts, loading: importsLoading, deleteImport, deleteDraft } = useImports(id);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isEditingBalance, setIsEditingBalance] = useState(false);
  const [balanceInput, setBalanceInput] = useState("");
  const [balanceDateInput, setBalanceDateInput] = useState("");
  const [isSavingBalance, setIsSavingBalance] = useState(false);

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

  const handleSaveEdit = async (data: Partial<typeof source>) => {
    await updateSource(source.id, data);
  };

  const handleStartEditBalance = () => {
    const currentBalance = source.openingBalance != null ? (source.openingBalance / 100).toFixed(2) : "";
    const currentDate = source.openingBalanceDate ? format(source.openingBalanceDate.toDate(), "yyyy-MM-dd") : "";
    setBalanceInput(currentBalance);
    setBalanceDateInput(currentDate);
    setIsEditingBalance(true);
  };

  const handleSaveBalance = async () => {
    setIsSavingBalance(true);
    try {
      const parsed = parseFloat(balanceInput.replace(",", "."));
      if (isNaN(parsed)) {
        alert("Invalid amount");
        setIsSavingBalance(false);
        return;
      }
      const balanceCents = Math.round(parsed * 100);
      await updateSource(source.id, {
        openingBalance: balanceCents,
        openingBalanceDate: balanceDateInput ? new Date(balanceDateInput).toISOString() : null,
        openingBalanceSource: "manual",
      } as any);
      setIsEditingBalance(false);
    } catch (error) {
      console.error("Failed to save balance:", error);
    } finally {
      setIsSavingBalance(false);
    }
  };

  const handleSync = async (fromYear?: number) => {
    setIsSyncing(true);
    try {
      const currentSyncYear = fromYear || finapiConfig?.syncFromYear || new Date().getFullYear();

      // Call Cloud Function directly (same pattern as CSV imports)
      const { callFunction } = await import("@/lib/firebase/callable");
      const result = await callFunction<
        { sourceId: string; fromYear?: number },
        { success: boolean; imported: number; skipped: number; reassigned: number; total: number }
      >("syncBankTransactions", {
        sourceId: source.id,
        fromYear: currentSyncYear,
      });

      console.log("Sync complete:", result);
    } catch (error) {
      console.error("Failed to sync:", error);
      const message = error instanceof Error ? error.message : "Failed to sync";
      alert(`Sync failed: ${message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncClick = () => handleSync();

  const handleYearChange = async (year: string) => {
    const newYear = parseInt(year, 10);
    // Update source with new syncFromYear and trigger re-sync
    await updateSource(source.id, {
      apiConfig: {
        ...source.apiConfig,
        syncFromYear: newYear,
      },
    } as any);
    // Re-sync with new year (will delete old transactions and fetch from new date)
    await handleSync(newYear);
  };

  // Check for any API connection (TrueLayer or finAPI)
  const isApiConnected = source.type === "api" &&
    (source.apiConfig?.provider === "truelayer" ||
     source.apiConfig?.provider === "finapi");
  const isTrueLayer = source.apiConfig?.provider === "truelayer";
  const isFinapi = source.apiConfig?.provider === "finapi";

  const trueLayerConfig = isTrueLayer ? source.apiConfig as unknown as TrueLayerApiConfig : undefined;
  const finapiConfig = isFinapi ? source.apiConfig as any : undefined;

  // Check if re-auth is needed (finAPI has expiry)
  const expiresAt = finapiConfig?.expiresAt?.toDate();
  const needsReauth = expiresAt ? expiresAt < new Date() : false;

  // Days until expiry
  const daysUntilExpiry = expiresAt
    ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  // Get provider name for display
  const providerName = trueLayerConfig?.providerName || finapiConfig?.institutionName || "Bank";
  const providerLogo = trueLayerConfig?.providerLogo || finapiConfig?.institutionLogo;
  const lastSyncAt = trueLayerConfig?.lastSyncAt || finapiConfig?.lastSyncAt;

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
            {isApiConnected && providerLogo ? (
              <div className="relative">
                <img
                  src={providerLogo}
                  alt=""
                  className="h-10 w-10 rounded-lg object-contain border border-border"
                />
                {/* Account type overlay */}
                <div className="absolute -bottom-1 -right-1 p-1 rounded-full bg-background border border-border shadow-sm">
                  {source.accountKind === "credit_card" ? (
                    <CreditCard className="h-3 w-3" />
                  ) : (
                    <Building2 className="h-3 w-3" />
                  )}
                </div>
              </div>
            ) : (
              <div className="p-2.5 rounded-lg bg-primary/10 border border-border">
                {source.accountKind === "credit_card" ? (
                  <CreditCard className="h-6 w-6 text-primary" />
                ) : (
                  <Building2 className="h-6 w-6 text-primary" />
                )}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold">{source.name}</h1>
                {/* Only show badge for warnings, not for normal connected state */}
                {isApiConnected && needsReauth && (
                  <Badge variant="destructive">Reconnect Required</Badge>
                )}
                {isApiConnected && !needsReauth && daysUntilExpiry !== null && daysUntilExpiry <= 7 && (
                  <Badge variant="outline" className="border-yellow-500 text-yellow-600">Expires Soon</Badge>
                )}
                {!isApiConnected && (
                  <Badge variant="secondary">CSV Import</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground font-mono">
                {source.accountKind === "credit_card"
                  ? `${source.cardBrand?.toUpperCase() || "Card"} ••••${source.cardLast4 || ""}`
                  : formatIban(source.iban)}
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

          {!isApiConnected && (
            <Button variant="outline" size="sm" onClick={handleConnect}>
              <Link2 className="h-4 w-4 mr-2" />
              Connect Bank
            </Button>
          )}
          {!isApiConnected && (
            <Button size="sm" onClick={() => router.push(`/sources/${source.id}/import`)}>
              <Upload className="h-4 w-4 mr-2" />
              Import CSV
            </Button>
          )}
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

              {/* Balance Section */}
              <div className="mt-4 pt-4 border-t">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium">Account Balance</p>
                  {!isEditingBalance && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleStartEditBalance}
                      className="h-7 text-xs text-muted-foreground"
                    >
                      <Pencil className="h-3 w-3 mr-1" />
                      {source.openingBalance != null ? "Edit" : "Set Opening Balance"}
                    </Button>
                  )}
                </div>

                {isEditingBalance ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">Opening Balance ({source.currency || "EUR"})</label>
                        <Input
                          type="text"
                          inputMode="decimal"
                          placeholder="e.g. 1234.56"
                          value={balanceInput}
                          onChange={(e) => setBalanceInput(e.target.value)}
                          className="h-8"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">As of Date</label>
                        <Input
                          type="date"
                          value={balanceDateInput}
                          onChange={(e) => setBalanceDateInput(e.target.value)}
                          className="h-8"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveBalance} disabled={isSavingBalance} className="h-7 text-xs">
                        {isSavingBalance ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setIsEditingBalance(false)} className="h-7 text-xs">
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-muted rounded-lg">
                        <Wallet className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Opening Balance</p>
                        {source.openingBalance != null ? (
                          <div>
                            <p className={`font-medium font-mono ${source.openingBalance >= 0 ? "text-green-700" : "text-red-600"}`}>
                              {formatCurrency(source.openingBalance, source.currency)}
                            </p>
                            {source.openingBalanceDate && (
                              <p className="text-xs text-muted-foreground">
                                {format(source.openingBalanceDate.toDate(), "dd.MM.yyyy")}
                              </p>
                            )}
                            {source.openingBalanceSource && (
                              <Badge variant="secondary" className="text-xs mt-1">
                                {source.openingBalanceSource === "csv_derived" ? "From CSV" :
                                 source.openingBalanceSource === "api_fetched" ? "From Bank API" :
                                 "Manual"}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">Not set</p>
                        )}
                      </div>
                    </div>
                    {source.latestBalance != null && (
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-muted rounded-lg">
                          <Wallet className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">Latest Balance</p>
                          <p className={`font-medium font-mono ${source.latestBalance >= 0 ? "text-green-700" : "text-red-600"}`}>
                            {formatCurrency(source.latestBalance, source.currency)}
                          </p>
                          {source.latestBalanceDate && (
                            <p className="text-xs text-muted-foreground">
                              {format(source.latestBalanceDate.toDate(), "dd.MM.yyyy")}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
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

          {/* Import/Sync History */}
          <ImportHistoryCard
            imports={imports}
            loading={importsLoading}
            sourceId={source.id}
            onDeleteImport={deleteImport}
            isApiConnected={isApiConnected}
            onSync={isApiConnected && !needsReauth ? handleSyncClick : undefined}
            isSyncing={isSyncing}
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
                    {isTrueLayer ? "TrueLayer" : isFinapi ? "finAPI" : "API"}
                  </span>
                </div>
                {expiresAt && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Valid Until</span>
                    <span className={`font-medium ${needsReauth ? "text-destructive" : daysUntilExpiry !== null && daysUntilExpiry <= 7 ? "text-yellow-600" : ""}`}>
                      {format(expiresAt, "MMM d, yyyy")}
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
                {/* Year selector for sync range */}
                <div className="flex justify-between items-center text-sm pt-2 border-t">
                  <span className="text-muted-foreground">Sync From</span>
                  <Select
                    value={String(finapiConfig?.syncFromYear || new Date().getFullYear())}
                    onValueChange={handleYearChange}
                    disabled={isSyncing}
                  >
                    <SelectTrigger className="w-24 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((year) => (
                        <SelectItem key={year} value={String(year)}>
                          {year}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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
