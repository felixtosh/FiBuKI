"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, ExternalLink, Loader2, CheckCircle, Building2, CreditCard, Wallet, AlertCircle, RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { BankSelector } from "@/components/sources/bank-selector";
import { InlineCountryExpand } from "@/components/sources/inline-country-expand";
import { useBankConnection, BankAccount } from "@/hooks/use-bank-connection";
import { useAuth } from "@/components/auth/auth-provider";
import { useSources } from "@/hooks/use-sources";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { FINAPI_SUPPORTED_COUNTRY_CODES } from "@/lib/banking/finapi-countries";

// Types for finAPI connections from API
interface FinapiAccount {
  accountId: number;
  iban?: string;
  ownerName?: string;
  accountType?: string;
  accountName?: string;
}

interface FinapiConnection {
  bankConnectionId: number;
  bankId: number;
  bankName?: string;
  bankLogo?: string;
  accountIds: number[];
  accounts: FinapiAccount[];
  updateStatus: string;
}

function ConnectBankContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const connectionId = searchParams.get("connectionId");
  const sourceId = searchParams.get("sourceId"); // Existing source to link
  const isBackingSuccess = searchParams.get("success") === "1";
  const { user } = useAuth();
  const { sources, deleteSource } = useSources();
  const [deletingInstitutionId, setDeletingInstitutionId] = useState<string | null>(null);
  const [expandingCountryCode, setExpandingCountryCode] = useState<string | null>(null);
  const [orphanedConnections, setOrphanedConnections] = useState<FinapiConnection[]>([]);
  const [linkedConnections, setLinkedConnections] = useState<FinapiConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [deletingOrphanedId, setDeletingOrphanedId] = useState<number | null>(null);
  const [resettingFinapi, setResettingFinapi] = useState(false);
  const [tokenExpired, setTokenExpired] = useState(false);
  // For showing accounts from existing finAPI connection (skip web form)
  const [existingConnectionAccounts, setExistingConnectionAccounts] = useState<{
    accounts: BankAccount[];
    bankConnectionId: number;
    institutionName?: string;
  } | null>(null);

  const {
    state,
    isLoading,
    selectCountry,
    goBackToCountry,
    startConnection,
    checkStatus,
    linkAccount,
    reset,
    clearError,
  } = useBankConnection(sourceId);

  // Fetch finAPI connections (both linked and orphaned)
  const fetchFinapiConnections = useCallback(async () => {
    if (!user) return;

    setLoadingConnections(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/banking/finapi-connections", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setOrphanedConnections(data.orphanedConnections || []);
        setLinkedConnections(data.linkedConnections || []);
        setTokenExpired(data.tokenExpired || false);
      }
    } catch (err) {
      console.error("Failed to fetch finAPI connections:", err);
    } finally {
      setLoadingConnections(false);
    }
  }, [user]);

  // Delete orphaned connection from finAPI
  const deleteOrphanedConnection = useCallback(async (bankConnectionId: number) => {
    if (!user) return;

    setDeletingOrphanedId(bankConnectionId);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/banking/finapi-connections", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bankConnectionId }),
      });

      if (response.ok) {
        // Remove from local state
        setOrphanedConnections((prev) =>
          prev.filter((c) => c.bankConnectionId !== bankConnectionId)
        );
      } else {
        const data = await response.json();
        console.error("Failed to delete orphaned connection:", data.error);
      }
    } catch (err) {
      console.error("Failed to delete orphaned connection:", err);
    } finally {
      setDeletingOrphanedId(null);
    }
  }, [user]);

  // Use existing finAPI connection accounts (skip web form)
  const loadExistingConnectionAccounts = useCallback((conn: FinapiConnection) => {
    // Convert finAPI accounts to BankAccount format
    const bankAccounts: BankAccount[] = conn.accounts.map(a => ({
      accountId: String(a.accountId),
      iban: a.iban || "",
      ownerName: a.ownerName,
      status: a.accountType || "unknown",
    }));

    setExistingConnectionAccounts({
      accounts: bankAccounts,
      bankConnectionId: conn.bankConnectionId,
      institutionName: conn.bankName,
    });
  }, []);

  // Reset existing connection accounts view
  const clearExistingConnectionAccounts = useCallback(() => {
    setExistingConnectionAccounts(null);
  }, []);

  // Reset finAPI user (delete and recreate) - use when finAPI is stuck
  const resetFinapiUser = useCallback(async () => {
    if (!user) return;

    setResettingFinapi(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/banking/finapi-connections", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "reset-finapi-user" }),
      });

      if (response.ok) {
        // Clear error and go back to country selection
        clearError();
        // Refetch connections (should be empty now)
        fetchFinapiConnections();
      } else {
        const data = await response.json();
        console.error("Failed to reset finAPI user:", data.error);
      }
    } catch (err) {
      console.error("Failed to reset finAPI user:", err);
    } finally {
      setResettingFinapi(false);
    }
  }, [user, clearError, fetchFinapiConnections]);

  // Fetch finAPI connections on mount and when an error occurs
  useEffect(() => {
    fetchFinapiConnections();
  }, [fetchFinapiConnections]);

  // Also refetch when we hit an error (to show orphaned connections in error state)
  useEffect(() => {
    if (state.step === "error" && state.error?.toLowerCase().includes("already connected")) {
      fetchFinapiConnections();
    }
  }, [state.step, state.error, fetchFinapiConnections]);

  // If we have a connectionId in URL (returning from bank), check status
  useEffect(() => {
    if (connectionId && state.step === "select-country") {
      // User returned from bank authorization
      checkStatus(connectionId);
    }
  }, [connectionId, state.step, checkStatus]);

  // Handle complete state
  useEffect(() => {
    if (state.step === "complete" && state.createdSourceId) {
      // Redirect to source page after short delay
      const timeout = setTimeout(() => {
        router.push(`/sources`);
      }, 2000);
      return () => clearTimeout(timeout);
    }
  }, [state.step, state.createdSourceId, router]);

  // Auto-check status when window regains focus (user returns from bank)
  useEffect(() => {
    if (state.step !== "authorizing" || !state.connectionId) return;

    const handleFocus = () => {
      // Small delay to ensure bank tab has closed/updated
      setTimeout(() => {
        if (!isLoading) {
          checkStatus(state.connectionId!);
        }
      }, 500);
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [state.step, state.connectionId, isLoading, checkStatus]);

  const handleBack = () => {
    router.push("/sources");
  };

  // Check if error is about already connected accounts
  const isAlreadyConnectedError = state.error?.toLowerCase().includes("already connected");

  // Get connected sources from this institution (if we know which one)
  const connectedFromInstitution = state.selectedInstitution
    ? sources.filter(s =>
        s.type === "api" &&
        (s.apiConfig as unknown as Record<string, unknown>)?.institutionId === state.selectedInstitution?.id
      )
    : [];

  // Error state
  if (state.step === "error") {
    // Check if this is an orphaned connection case (already connected error but no sources in our app)
    const hasOrphanedForThisBank = isAlreadyConnectedError &&
      connectedFromInstitution.length === 0 &&
      orphanedConnections.length > 0;

    return (
      <div className="container max-w-lg mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle className={isAlreadyConnectedError ? "" : "text-destructive"}>
              {isAlreadyConnectedError ? "Accounts Already Connected" : "Connection Failed"}
            </CardTitle>
            <CardDescription>
              {isAlreadyConnectedError
                ? hasOrphanedForThisBank
                  ? "This bank connection exists in finAPI but isn't linked to your account. Delete it below to reconnect fresh."
                  : "These accounts from this bank are already connected to your account."
                : state.error}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Show connected sources if this is an "already connected" error */}
            {isAlreadyConnectedError && connectedFromInstitution.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Your connected accounts:</p>
                {connectedFromInstitution.map((source) => (
                  <button
                    key={source.id}
                    onClick={() => router.push(`/sources/${source.id}`)}
                    className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left"
                  >
                    <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                      {source.accountKind === "credit_card" ? (
                        <CreditCard className="h-5 w-5" />
                      ) : (
                        <Building2 className="h-5 w-5" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{source.name}</p>
                      <p className="text-sm text-muted-foreground font-mono truncate">
                        {source.iban || "No IBAN"}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Show orphaned connections for "already connected" error when no local sources */}
            {hasOrphanedForThisBank && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-yellow-800">Orphaned connections in finAPI:</p>
                {orphanedConnections.map((conn) => {
                  const isDeleting = deletingOrphanedId === conn.bankConnectionId;
                  return (
                    <div key={conn.bankConnectionId} className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-3 p-3 rounded-lg border border-yellow-200 bg-yellow-50 text-left">
                        <div className="w-10 h-10 rounded bg-yellow-100 flex items-center justify-center text-yellow-600 shrink-0">
                          <Building2 className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">
                            {conn.bankName || `Bank ${conn.bankId}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {conn.accountIds.length} account(s)
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteOrphanedConnection(conn.bankConnectionId)}
                        disabled={isDeleting}
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Show reset button when finAPI says "already connected" but we can't find any connections */}
            {isAlreadyConnectedError && connectedFromInstitution.length === 0 && orphanedConnections.length === 0 && (
              <Alert className="border-yellow-200 bg-yellow-50">
                <AlertTriangle className="h-4 w-4 text-yellow-600" />
                <AlertDescription className="text-yellow-800">
                  finAPI reports a connection exists but we can&apos;t find it. This can happen with sandbox accounts.
                  Try resetting your finAPI user to start fresh.
                </AlertDescription>
              </Alert>
            )}

            <Button variant="outline" className="w-full" onClick={clearError}>
              {isAlreadyConnectedError ? "Connect Different Bank" : "Try Again"}
            </Button>

            {/* Reset finAPI button for stuck state */}
            {isAlreadyConnectedError && connectedFromInstitution.length === 0 && orphanedConnections.length === 0 && (
              <Button
                variant="destructive"
                className="w-full"
                onClick={resetFinapiUser}
                disabled={resettingFinapi}
              >
                {resettingFinapi ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Resetting...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Reset finAPI User
                  </>
                )}
              </Button>
            )}

            <Button variant="ghost" className="w-full" onClick={handleBack}>
              Back to Accounts
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Authorizing state (waiting for user to complete bank auth)
  if (state.step === "authorizing") {
    return (
      <div className="container max-w-lg mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle>Complete Authorization</CardTitle>
            <CardDescription>
              Please complete the authorization in the bank window that opened.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertDescription className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Waiting for bank authorization...
              </AlertDescription>
            </Alert>

            <Button
              className="w-full"
              onClick={() => {
                if (state.connectionId) {
                  checkStatus(state.connectionId);
                }
              }}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Checking...
                </>
              ) : (
                "I've completed authorization"
              )}
            </Button>

            {state.authorizationUrl && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => window.open(state.authorizationUrl!, "_blank")}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Re-open Bank Authorization
              </Button>
            )}

            <Button variant="ghost" className="w-full text-muted-foreground" onClick={reset}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Account selection from existing finAPI connection (skipped web form)
  if (existingConnectionAccounts) {
    return (
      <ExistingConnectionAccountsView
        accounts={existingConnectionAccounts.accounts}
        bankConnectionId={existingConnectionAccounts.bankConnectionId}
        institutionName={existingConnectionAccounts.institutionName}
        onCancel={clearExistingConnectionAccounts}
        onConnectDifferent={() => {
          clearExistingConnectionAccounts();
          // Optionally start fresh connection flow
        }}
      />
    );
  }

  // Account selection state (from web form flow)
  if (state.step === "select-accounts") {
    return (
      <AccountSelectionView
        accounts={state.accounts}
        connectionId={state.connectionId!}
        institutionName={state.selectedInstitution?.name}
        onSelect={linkAccount}
        onCancel={reset}
        isLoading={isLoading}
      />
    );
  }

  // Creating source state
  if (state.step === "creating-source") {
    return (
      <div className="container max-w-lg mx-auto py-8">
        <Card>
          <CardContent className="py-8 text-center space-y-4">
            <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary" />
            <div>
              <h3 className="text-lg font-semibold">Creating Bank Account...</h3>
              <p className="text-muted-foreground">
                Setting up your bank connection.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Complete state
  if (state.step === "complete") {
    return (
      <div className="container max-w-lg mx-auto py-8">
        <Card>
          <CardContent className="py-8 text-center space-y-4">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
            <div>
              <h3 className="text-lg font-semibold">Bank Connected!</h3>
              <p className="text-muted-foreground">
                Your bank account has been successfully connected.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Redirecting to your sources...
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get sources grouped by bank connection ID for delete functionality
  const sourcesByBankConnection = new Map<number, typeof sources>();
  for (const source of sources) {
    if (source.type === "api") {
      const bankConnectionId = (source.apiConfig as unknown as Record<string, unknown>)?.bankConnectionId as number;
      if (bankConnectionId) {
        const existing = sourcesByBankConnection.get(bankConnectionId) || [];
        sourcesByBankConnection.set(bankConnectionId, [...existing, source]);
      }
    }
  }

  // Country & Bank selection
  return (
    <div className="container max-w-lg mx-auto py-8">
      <div className="mb-6">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Sources
        </Button>
      </div>

      {isBackingSuccess && (
        <Alert className="mb-4 border-green-300 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-900">
            <span className="font-medium">Thank you for backing!</span> We&apos;ll notify you when
            PSD2 banking goes live. In the meantime, you can{" "}
            <button
              onClick={() => router.push("/sources")}
              className="underline font-medium hover:text-green-700"
            >
              add a manual bank account
            </button>{" "}
            and import transactions via CSV.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{sourceId ? "Connect Bank Account" : "Connect Your Bank"}</CardTitle>
          <CardDescription>
            {sourceId
              ? "Link your existing account to automatically sync transactions."
              : "Securely connect your bank account to automatically sync transactions."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {expandingCountryCode ? (
            <InlineCountryExpand
              countryCode={expandingCountryCode}
              onBack={() => setExpandingCountryCode(null)}
            />
          ) : (
            <BankSelector
              selectedCountry={state.selectedCountry}
              onCountrySelect={selectCountry}
              onBankSelect={startConnection}
              onBack={state.selectedCountry ? goBackToCountry : undefined}
              isLoading={isLoading}
              onExpandCountry={setExpandingCountryCode}
            />
          )}
        </CardContent>
      </Card>

      {/* Loading indicator while fetching finAPI connections */}
      {loadingConnections && !state.selectedCountry && (
        <Card className="mt-4">
          <CardContent className="py-6">
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Checking finAPI connections...</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Show already connected banks from finAPI */}
      {!loadingConnections && linkedConnections.length > 0 && !state.selectedCountry && (
        <Card className="mt-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Already Connected Banks</CardTitle>
            <CardDescription className="text-sm">
              {tokenExpired
                ? "Re-authenticate to add more accounts or sync transactions"
                : "Add more accounts from banks you've already connected"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {tokenExpired && (
              <Alert className="mb-3 border-yellow-200 bg-yellow-50">
                <AlertCircle className="h-4 w-4 text-yellow-600" />
                <AlertDescription className="text-yellow-800 text-sm">
                  Session expired. Click a bank to re-authenticate and get fresh tokens.
                </AlertDescription>
              </Alert>
            )}
            {linkedConnections.map((conn) => {
              const sourcesFromBank = sourcesByBankConnection.get(conn.bankConnectionId) || [];
              const isDeleting = deletingInstitutionId === String(conn.bankId);
              // Need re-auth if: no accounts could be fetched OR refresh token expired
              // When refresh token is expired, we must go through web form to get new tokens
              const needsReauth = conn.accounts.length === 0 || tokenExpired;

                return (
                  <div key={conn.bankConnectionId} className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (needsReauth) {
                          // Token expired - need to re-authenticate via web form
                          const institution = {
                            id: String(conn.bankId),
                            name: conn.bankName || `Bank ${conn.bankId}`,
                            logo: conn.bankLogo || "",
                            providerId: "finapi" as const,
                            transaction_total_days: "365",
                            countries: [...FINAPI_SUPPORTED_COUNTRY_CODES],
                          };
                          startConnection(institution);
                        } else {
                          // Use existing connection's accounts directly (skip web form)
                          loadExistingConnectionAccounts(conn);
                        }
                      }}
                      disabled={isLoading || isDeleting}
                      className="flex-1 flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors text-left disabled:opacity-50"
                    >
                      {conn.bankLogo ? (
                        <img
                          src={conn.bankLogo}
                          alt=""
                          className="w-10 h-10 rounded object-contain bg-white shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                          <Building2 className="h-5 w-5" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {conn.bankName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {sourcesFromBank.length} account(s) in app
                          {needsReauth && (
                            <span className="text-yellow-600 ml-1">• Re-auth needed</span>
                          )}
                        </p>
                      </div>
                      {needsReauth && (
                        <RefreshCw className="h-4 w-4 text-yellow-600 shrink-0" />
                      )}
                    </button>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          disabled={isDeleting}
                        >
                          {isDeleting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove Bank Connection?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove {sourcesFromBank.length} account(s) from {conn.bankName || `Bank ${conn.bankId}`}.
                            Transactions will remain but lose their source reference.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={async () => {
                              setDeletingInstitutionId(String(conn.bankId));
                              try {
                                for (const s of sourcesFromBank) {
                                  await deleteSource(s.id);
                                }
                                // Refetch connections after delete
                                fetchFinapiConnections();
                              } finally {
                                setDeletingInstitutionId(null);
                              }
                            }}
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                );
              })}
          </CardContent>
        </Card>
      )}

      {/* Orphaned connections (exist in finAPI but not in our app) */}
      {!loadingConnections && orphanedConnections.length > 0 && !state.selectedCountry && (
        <Card className="mt-4 border-yellow-200 bg-yellow-50/50">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <CardTitle className="text-base text-yellow-800">Orphaned Bank Connections</CardTitle>
            </div>
            <CardDescription className="text-sm text-yellow-700">
              These connections exist in finAPI but aren&apos;t linked to your account.
              Delete them to reconnect fresh or use them to add accounts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {orphanedConnections.map((conn) => {
              const isDeleting = deletingOrphanedId === conn.bankConnectionId;

              return (
                <div key={conn.bankConnectionId} className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-3 p-3 rounded-lg border border-yellow-200 bg-white text-left">
                    {conn.bankLogo ? (
                      <img
                        src={conn.bankLogo}
                        alt=""
                        className="w-10 h-10 rounded object-contain bg-white shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded bg-yellow-100 flex items-center justify-center text-yellow-600 shrink-0">
                        <Building2 className="h-5 w-5" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">
                        {conn.bankName || `Bank ${conn.bankId}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {conn.accountIds.length} account(s) in finAPI
                      </p>
                    </div>
                  </div>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={isDeleting}
                      >
                        {isDeleting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete Bank Connection?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove the connection to {conn.bankName || `Bank ${conn.bankId}`} from finAPI.
                          You can then reconnect to this bank fresh.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => deleteOrphanedConnection(conn.bankConnectionId)}
                        >
                          Delete from finAPI
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Security note */}
      <p className="text-xs text-muted-foreground text-center mt-4">
        Powered by finAPI. We never see your bank credentials.
        <br />
        Connection is valid for 90 days per PSD2 regulations.
      </p>
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="container max-w-lg mx-auto py-8">
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
        </CardContent>
      </Card>
    </div>
  );
}

export default function ConnectBankPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ConnectBankContent />
    </Suspense>
  );
}

// Account Selection Component
interface AccountSelectionViewProps {
  accounts: BankAccount[];
  connectionId: string;
  institutionName?: string;
  onSelect: (accountId: string, name: string, connectionId: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}

function AccountSelectionView({
  accounts,
  connectionId,
  institutionName,
  onSelect,
  onCancel,
  isLoading,
}: AccountSelectionViewProps) {
  const { user } = useAuth();
  const router = useRouter();
  const { sources } = useSources();

  // All hooks must be at the top, before any derived values
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [connectingIndex, setConnectingIndex] = useState(-1);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncFromYear, setSyncFromYear] = useState(new Date().getFullYear());
  const [initialized, setInitialized] = useState(false);

  // Check which accounts are already connected (by finAPI accountId - more reliable than IBAN)
  const connectedAccountIds = new Set(
    sources
      .filter((s) => s.type === "api")
      .map((s) => {
        const apiConfig = s.apiConfig as Record<string, unknown> | undefined;
        return apiConfig?.accountId ? String(apiConfig.accountId) : null;
      })
      .filter(Boolean) as string[]
  );

  const isAlreadyConnected = (accountId: string) => connectedAccountIds.has(accountId);

  // Get accounts that can be connected (not already connected)
  const availableAccounts = accounts.filter(a => !isAlreadyConnected(a.accountId));

  // Pre-select all available accounts by default (only once on mount)
  useEffect(() => {
    if (!initialized && availableAccounts.length > 0) {
      setSelectedAccountIds(new Set(availableAccounts.map(a => a.accountId)));
      setInitialized(true);
    }
  }, [availableAccounts, initialized]);

  // Remove already-connected accounts from selection when sources load/change
  useEffect(() => {
    if (connectedAccountIds.size > 0) {
      setSelectedAccountIds(prev => {
        const filtered = new Set([...prev].filter(id => !connectedAccountIds.has(id)));
        return filtered.size !== prev.size ? filtered : prev;
      });
    }
  }, [connectedAccountIds.size]); // Only re-run when count changes

  // Check if ALL accounts are already connected
  const allAccountsConnected = accounts.length > 0 && availableAccounts.length === 0;

  // Get sources that match connected accounts (for syncing)
  const connectedSources = sources.filter(s => {
    if (s.type !== "api") return false;
    const apiConfig = s.apiConfig as Record<string, unknown> | undefined;
    const sourceAccountId = apiConfig?.accountId ? String(apiConfig.accountId) : null;
    return sourceAccountId && accounts.some(a => a.accountId === sourceAccountId);
  });

  // Generate default name for an account
  const getDefaultName = (account: BankAccount) => {
    const ownerPart = account.ownerName || (account.iban ? account.iban.slice(-4) : "Account");
    return institutionName ? `${institutionName} - ${ownerPart}` : ownerPart;
  };

  const toggleAccount = (account: BankAccount) => {
    // Don't allow selecting already connected accounts
    if (isAlreadyConnected(account.accountId)) return;

    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(account.accountId)) {
        newSet.delete(account.accountId);
      } else {
        newSet.add(account.accountId);
      }
      return newSet;
    });
  };

  const isSelected = (accountId: string) => selectedAccountIds.has(accountId);

  const handleConnect = async () => {
    const accountsToConnect = availableAccounts.filter(a => selectedAccountIds.has(a.accountId));
    if (accountsToConnect.length === 0) return;

    setIsConnecting(true);
    setError(null);

    try {
      const token = await user?.getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      for (let i = 0; i < accountsToConnect.length; i++) {
        setConnectingIndex(i);
        const acc = accountsToConnect[i];

        const response = await fetch("/api/banking/accounts", {
          method: "POST",
          headers,
          body: JSON.stringify({
            connectionId,
            accountId: acc.accountId,
            name: getDefaultName(acc),
            syncFromYear,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to create account ${i + 1}`);
        }
      }

      // All accounts connected - redirect
      router.push("/sources");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect accounts");
    } finally {
      setIsConnecting(false);
      setConnectingIndex(-1);
    }
  };

  // Sync all already-connected accounts from the selected year
  const handleSyncAll = async () => {
    if (connectedSources.length === 0) return;

    setIsSyncing(true);
    setError(null);

    try {
      const token = await user?.getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      for (let i = 0; i < connectedSources.length; i++) {
        setConnectingIndex(i);
        const source = connectedSources[i];

        const response = await fetch("/api/banking/sync", {
          method: "POST",
          headers,
          body: JSON.stringify({
            sourceId: source.id,
            fromYear: syncFromYear,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || `Failed to sync account ${i + 1}`);
        }
      }

      // All accounts synced - redirect
      router.push("/sources");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync accounts");
    } finally {
      setIsSyncing(false);
      setConnectingIndex(-1);
    }
  };

  const getAccountIcon = (type?: string) => {
    switch (type?.toLowerCase()) {
      case "creditcard":
        return <CreditCard className="h-5 w-5" />;
      case "savings":
        return <Wallet className="h-5 w-5" />;
      default:
        return <Building2 className="h-5 w-5" />;
    }
  };

  return (
    <div className="container max-w-lg mx-auto py-8 max-h-screen overflow-y-auto">
      <Card>
        <CardHeader>
          <CardTitle>Select Accounts</CardTitle>
          <CardDescription>
            Choose which accounts to connect{institutionName ? ` from ${institutionName}` : ""}. You can select multiple.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Year selector */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div>
              <p className="text-sm font-medium">Sync transactions from</p>
              <p className="text-xs text-muted-foreground">Jan 1 of selected year</p>
            </div>
            <Select
              value={String(syncFromYear)}
              onValueChange={(v) => setSyncFromYear(parseInt(v, 10))}
            >
              <SelectTrigger className="w-24">
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

          {/* Account list */}
          <div className="space-y-2">
            {accounts.map((account) => {
              const selected = isSelected(account.accountId);
              const alreadyConnected = isAlreadyConnected(account.accountId);
              return (
                <button
                  key={account.accountId}
                  type="button"
                  onClick={() => toggleAccount(account)}
                  disabled={alreadyConnected}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                    alreadyConnected
                      ? "opacity-50 cursor-not-allowed bg-muted/30"
                      : selected
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                    {getAccountIcon(account.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {account.ownerName || account.iban || `Account ${account.accountId}`}
                    </p>
                    {account.iban && (
                      <p className="text-sm text-muted-foreground font-mono truncate">
                        {account.iban}
                      </p>
                    )}
                    {alreadyConnected && (
                      <p className="text-xs text-yellow-600 flex items-center gap-1 mt-1">
                        <AlertCircle className="h-3 w-3" />
                        Already connected
                      </p>
                    )}
                  </div>
                  {selected && !alreadyConnected && (
                    <CheckCircle className="h-5 w-5 text-primary shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {selectedAccountIds.size > 0 && !allAccountsConnected && (
            <p className="text-xs text-muted-foreground text-center">
              {selectedAccountIds.size} account{selectedAccountIds.size > 1 ? "s" : ""} selected
            </p>
          )}

          {/* Error */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-4">
            <Button
              variant="outline"
              className="flex-1"
              onClick={onCancel}
              disabled={isLoading || isConnecting || isSyncing}
            >
              Cancel
            </Button>
            {allAccountsConnected ? (
              <Button
                className="flex-1"
                onClick={handleSyncAll}
                disabled={isLoading || isSyncing}
              >
                {isSyncing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {connectingIndex >= 0
                      ? `Syncing ${connectingIndex + 1}/${connectedSources.length}...`
                      : "Syncing..."}
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Sync All from {syncFromYear}
                  </>
                )}
              </Button>
            ) : (
              <Button
                className="flex-1"
                onClick={handleConnect}
                disabled={selectedAccountIds.size === 0 || isLoading || isConnecting}
              >
                {isLoading || isConnecting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {connectingIndex >= 0
                      ? `Connecting ${connectingIndex + 1}/${selectedAccountIds.size}...`
                      : "Connecting..."}
                  </>
                ) : (
                  `Connect ${selectedAccountIds.size > 1 ? `${selectedAccountIds.size} Accounts` : "Account"}`
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Existing Connection Accounts View - for adding accounts from already-connected finAPI banks
interface ExistingConnectionAccountsViewProps {
  accounts: BankAccount[];
  bankConnectionId: number;
  institutionName?: string;
  onCancel: () => void;
  onConnectDifferent: () => void;
}

function ExistingConnectionAccountsView({
  accounts,
  bankConnectionId,
  institutionName,
  onCancel,
  onConnectDifferent,
}: ExistingConnectionAccountsViewProps) {
  const { user } = useAuth();
  const router = useRouter();
  const { sources } = useSources();

  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [connectingIndex, setConnectingIndex] = useState(-1);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncFromYear, setSyncFromYear] = useState(new Date().getFullYear());
  const [initialized, setInitialized] = useState(false);

  // Check which accounts are already connected (by finAPI accountId - more reliable than IBAN)
  const connectedAccountIds = new Set(
    sources
      .filter((s) => s.type === "api")
      .map((s) => {
        const apiConfig = s.apiConfig as Record<string, unknown> | undefined;
        return apiConfig?.accountId ? String(apiConfig.accountId) : null;
      })
      .filter(Boolean) as string[]
  );

  const isAlreadyConnected = (accountId: string) => connectedAccountIds.has(accountId);

  // Get accounts that can be connected (not already connected)
  const availableAccounts = accounts.filter(a => !isAlreadyConnected(a.accountId));

  // Pre-select all available accounts by default
  useEffect(() => {
    if (!initialized && availableAccounts.length > 0) {
      setSelectedAccountIds(new Set(availableAccounts.map(a => a.accountId)));
      setInitialized(true);
    }
  }, [availableAccounts, initialized]);

  // Remove already-connected accounts from selection when sources load/change
  useEffect(() => {
    if (connectedAccountIds.size > 0) {
      setSelectedAccountIds(prev => {
        const filtered = new Set([...prev].filter(id => !connectedAccountIds.has(id)));
        return filtered.size !== prev.size ? filtered : prev;
      });
    }
  }, [connectedAccountIds.size]); // Only re-run when count changes

  const allAccountsConnected = accounts.length > 0 && availableAccounts.length === 0;

  const getDefaultName = (account: BankAccount) => {
    const ownerPart = account.ownerName || (account.iban ? account.iban.slice(-4) : "Account");
    return institutionName ? `${institutionName} - ${ownerPart}` : ownerPart;
  };

  const toggleAccount = (account: BankAccount) => {
    if (isAlreadyConnected(account.accountId)) return;
    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(account.accountId)) {
        newSet.delete(account.accountId);
      } else {
        newSet.add(account.accountId);
      }
      return newSet;
    });
  };

  const isSelected = (accountId: string) => selectedAccountIds.has(accountId);

  const handleConnect = async () => {
    const accountsToConnect = availableAccounts.filter(a => selectedAccountIds.has(a.accountId));
    if (accountsToConnect.length === 0) return;

    setIsConnecting(true);
    setError(null);

    try {
      const token = await user?.getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      for (let i = 0; i < accountsToConnect.length; i++) {
        setConnectingIndex(i);
        const acc = accountsToConnect[i];

        // Use the new finapi-accounts endpoint
        const response = await fetch("/api/banking/finapi-accounts", {
          method: "POST",
          headers,
          body: JSON.stringify({
            bankConnectionId,
            accountId: acc.accountId,
            name: getDefaultName(acc),
            syncFromYear,
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          // Skip if already connected (409)
          if (response.status === 409) {
            console.log(`Account ${acc.accountId} already connected, skipping`);
            continue;
          }
          throw new Error(data.error || `Failed to create account ${i + 1}`);
        }
      }

      // All accounts connected - redirect
      router.push("/sources");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect accounts");
    } finally {
      setIsConnecting(false);
      setConnectingIndex(-1);
    }
  };

  const getAccountIcon = (type?: string) => {
    switch (type?.toLowerCase()) {
      case "creditcard":
        return <CreditCard className="h-5 w-5" />;
      case "savings":
        return <Wallet className="h-5 w-5" />;
      default:
        return <Building2 className="h-5 w-5" />;
    }
  };

  return (
    <div className="container max-w-lg mx-auto py-8 max-h-screen overflow-y-auto">
      <Card>
        <CardHeader>
          <CardTitle>Add Accounts</CardTitle>
          <CardDescription>
            {allAccountsConnected
              ? `All accounts from ${institutionName || "this bank"} are already connected.`
              : `Select accounts to add from ${institutionName || "this bank"}. No login required - using existing connection.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Year selector - only show if there are accounts to connect */}
          {!allAccountsConnected && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <div>
                <p className="text-sm font-medium">Sync transactions from</p>
                <p className="text-xs text-muted-foreground">Jan 1 of selected year</p>
              </div>
              <Select
                value={String(syncFromYear)}
                onValueChange={(v) => setSyncFromYear(parseInt(v, 10))}
              >
                <SelectTrigger className="w-24">
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
          )}

          {/* Account list */}
          <div className="space-y-2">
            {accounts.map((account) => {
              const selected = isSelected(account.accountId);
              const alreadyConnected = isAlreadyConnected(account.accountId);
              return (
                <button
                  key={account.accountId}
                  type="button"
                  onClick={() => toggleAccount(account)}
                  disabled={alreadyConnected}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                    alreadyConnected
                      ? "opacity-50 cursor-not-allowed bg-muted/30"
                      : selected
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-muted-foreground shrink-0">
                    {getAccountIcon(account.status)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {account.ownerName || account.iban || `Account ${account.accountId}`}
                    </p>
                    {account.iban && (
                      <p className="text-sm text-muted-foreground font-mono truncate">
                        {account.iban}
                      </p>
                    )}
                    {alreadyConnected && (
                      <p className="text-xs text-yellow-600 flex items-center gap-1 mt-1">
                        <AlertCircle className="h-3 w-3" />
                        Already connected
                      </p>
                    )}
                  </div>
                  {selected && !alreadyConnected && (
                    <CheckCircle className="h-5 w-5 text-primary shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {selectedAccountIds.size > 0 && !allAccountsConnected && (
            <p className="text-xs text-muted-foreground text-center">
              {selectedAccountIds.size} account{selectedAccountIds.size > 1 ? "s" : ""} selected
            </p>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-4">
            {allAccountsConnected ? (
              <>
                <Button variant="outline" className="w-full" onClick={onConnectDifferent}>
                  Connect Different Bank
                </Button>
                <Button variant="ghost" className="w-full" onClick={() => router.push("/sources")}>
                  Back to Accounts
                </Button>
              </>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={onCancel}
                  disabled={isConnecting}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleConnect}
                  disabled={selectedAccountIds.size === 0 || isConnecting}
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      {connectingIndex >= 0
                        ? `Adding ${connectingIndex + 1}/${selectedAccountIds.size}...`
                        : "Adding..."}
                    </>
                  ) : (
                    `Add ${selectedAccountIds.size > 1 ? `${selectedAccountIds.size} Accounts` : "Account"}`
                  )}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
