"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Building2, CheckCircle, Loader2, Link2, Plus } from "lucide-react";
import { formatIban, normalizeIban } from "@/lib/import/deduplication";
import { BankAccount } from "@/hooks/use-bank-connection";
import { TransactionSource } from "@/types/source";
import { useAuth } from "@/components/auth";

interface AccountSelection {
  accountId: string;
  iban: string;
  ownerName: string;
  selected: boolean;
  mode: "create" | "link";
  selectedSourceId: string | null;
  newAccountName: string;
  matchedSourceId: string | null;
  isAlreadyConnected: boolean;
  existingSourceName?: string;
}

function SelectAccountsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { userId } = useAuth();
  const connectionId = searchParams.get("connectionId");

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [existingSources, setExistingSources] = useState<TransactionSource[]>([]);
  const [selections, setSelections] = useState<Map<string, AccountSelection>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [connectedCount, setConnectedCount] = useState(0);

  // Fetch accounts and existing sources on mount
  useEffect(() => {
    if (!connectionId) {
      router.push("/sources/connect");
      return;
    }

    async function fetchData() {
      try {
        // Fetch bank accounts from TrueLayer
        const accountsRes = await fetch(`/api/truelayer/accounts?connectionId=${connectionId}`);
        const accountsData = await accountsRes.json();

        if (!accountsRes.ok) {
          throw new Error(accountsData.error || "Failed to fetch accounts");
        }

        const bankAccounts: BankAccount[] = accountsData.accounts || [];

        // Fetch ALL existing sources to check for duplicates
        const sourcesQuery = query(
          collection(db, "sources"),
          where("userId", "==", userId),
          where("isActive", "==", true)
        );
        const sourcesSnap = await getDocs(sourcesQuery);
        const allSources = sourcesSnap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as TransactionSource[];

        // Filter to only unconnected sources (no apiConfig or type !== "api") for linking
        const unconnectedSources = allSources.filter(
          (s) => s.type !== "api" && !s.apiConfig
        );

        setAccounts(bankAccounts);
        setExistingSources(unconnectedSources);

        // Initialize selections with IBAN matching
        const initialSelections = new Map<string, AccountSelection>();
        bankAccounts.forEach((account) => {
          const normalizedBankIban = normalizeIban(account.iban || "");

          // Check if this IBAN already exists in ANY source (for duplicate prevention)
          const existingSource = allSources.find(
            (s) => s.iban && normalizeIban(s.iban) === normalizedBankIban
          );
          const isAlreadyConnected = !!existingSource;

          // For linking, only check unconnected sources
          const matchedUnconnectedSource = unconnectedSources.find(
            (s) => s.iban && normalizeIban(s.iban) === normalizedBankIban
          );

          initialSelections.set(account.accountId, {
            accountId: account.accountId,
            iban: account.iban,
            ownerName: account.ownerName || "Account",
            selected: false, // Opt-in: user must explicitly select accounts to add
            mode: matchedUnconnectedSource ? "link" : "create",
            selectedSourceId: matchedUnconnectedSource?.id || null,
            newAccountName: account.ownerName || "New Account",
            matchedSourceId: matchedUnconnectedSource?.id || null,
            isAlreadyConnected,
            existingSourceName: existingSource?.name,
          });
        });

        setSelections(initialSelections);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [connectionId, router, userId]);

  // Get selected accounts count
  const selectedCount = useMemo(() => {
    return Array.from(selections.values()).filter((s) => s.selected).length;
  }, [selections]);

  // Check for duplicate source selections
  const duplicateSourceError = useMemo(() => {
    const selectedSourceIds = Array.from(selections.values())
      .filter((s) => s.selected && s.mode === "link" && s.selectedSourceId)
      .map((s) => s.selectedSourceId);

    const duplicates = selectedSourceIds.filter(
      (id, index) => selectedSourceIds.indexOf(id) !== index
    );

    if (duplicates.length > 0) {
      const source = existingSources.find((s) => s.id === duplicates[0]);
      return `"${source?.name}" is selected for multiple accounts`;
    }
    return null;
  }, [selections, existingSources]);

  // Update selection for an account
  const updateSelection = (accountId: string, updates: Partial<AccountSelection>) => {
    setSelections((prev) => {
      const newMap = new Map(prev);
      const current = newMap.get(accountId);
      if (current) {
        newMap.set(accountId, { ...current, ...updates });
      }
      return newMap;
    });
  };

  // Handle form submission
  const handleSubmit = async () => {
    const selectedAccounts = Array.from(selections.values()).filter((s) => s.selected);

    if (selectedAccounts.length === 0) {
      setError("Please select at least one account");
      return;
    }

    // Validate create mode accounts have names
    const missingNames = selectedAccounts.filter(
      (s) => s.mode === "create" && !s.newAccountName.trim()
    );
    if (missingNames.length > 0) {
      setError("Please enter names for all new accounts");
      return;
    }

    if (duplicateSourceError) {
      setError(duplicateSourceError);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    let successCount = 0;
    const errors: string[] = [];

    // Process each selected account
    for (const selection of selectedAccounts) {
      try {
        const response = await fetch("/api/truelayer/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId,
            accountId: selection.accountId,
            ...(selection.mode === "link"
              ? { sourceId: selection.selectedSourceId }
              : { name: selection.newAccountName.trim() }),
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          errors.push(`${selection.ownerName}: ${data.error}`);
        } else {
          successCount++;
        }
      } catch (err) {
        errors.push(
          `${selection.ownerName}: ${err instanceof Error ? err.message : "Failed"}`
        );
      }
    }

    setIsSubmitting(false);

    if (successCount > 0) {
      setConnectedCount(successCount);
      setSuccess(true);
      setTimeout(() => {
        router.push("/sources");
      }, 2000);
    } else {
      setError(errors.join("; "));
    }
  };

  // Success state
  if (success) {
    return (
      <div className="container max-w-2xl mx-auto py-8">
        <Card>
          <CardContent className="py-8 text-center space-y-4">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto" />
            <div>
              <h3 className="text-lg font-semibold">
                {connectedCount} Account{connectedCount !== 1 ? "s" : ""} Connected!
              </h3>
              <p className="text-muted-foreground">
                Your bank accounts have been successfully connected.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">Redirecting to your sources...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="container max-w-2xl mx-auto py-8">
        <Card>
          <CardContent className="py-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">Loading your accounts...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="container max-w-2xl mx-auto py-4 px-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/sources")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Cancel
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="container max-w-2xl mx-auto px-4 pb-8">
          <Card>
            <CardHeader>
              <CardTitle>Connect Bank Accounts</CardTitle>
              <CardDescription>
                Choose which accounts to connect. You can link them to existing sources or create new
                ones.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {duplicateSourceError && (
                <Alert variant="destructive">
                  <AlertDescription>{duplicateSourceError}</AlertDescription>
                </Alert>
              )}

              {accounts.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground">
                  No accounts found. Please try connecting again.
                </div>
              ) : (
                <>
                  {/* Account list */}
                  <div className="space-y-4">
                    {accounts.map((account) => {
                      const selection = selections.get(account.accountId);
                      if (!selection) return null;

                      return (
                        <AccountCard
                          key={account.accountId}
                          account={account}
                          selection={selection}
                          existingSources={existingSources}
                          onUpdate={(updates) => updateSelection(account.accountId, updates)}
                        />
                      );
                    })}
                  </div>

                  {/* Submit button */}
                  <Button
                    className="w-full"
                    onClick={handleSubmit}
                    disabled={selectedCount === 0 || isSubmitting || !!duplicateSourceError}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Connecting...
                      </>
                    ) : (
                      `Connect ${selectedCount} Account${selectedCount !== 1 ? "s" : ""}`
                    )}
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

interface AccountCardProps {
  account: BankAccount;
  selection: AccountSelection;
  existingSources: TransactionSource[];
  onUpdate: (updates: Partial<AccountSelection>) => void;
}

function AccountCard({ account, selection, existingSources, onUpdate }: AccountCardProps) {
  const isMatched = selection.matchedSourceId !== null;
  const isAlreadyConnected = selection.isAlreadyConnected;

  return (
    <div
      className={`rounded-lg border p-4 space-y-3 transition-colors ${
        isAlreadyConnected
          ? "opacity-50 bg-muted/30"
          : selection.selected
          ? "border-primary bg-primary/5"
          : "opacity-60"
      }`}
    >
      {/* Header with checkbox */}
      <div className="flex items-start gap-3">
        <Checkbox
          checked={selection.selected}
          onCheckedChange={(checked: boolean | "indeterminate") => onUpdate({ selected: checked === true })}
          className="mt-1"
          disabled={isAlreadyConnected}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <p className="font-medium">{account.ownerName || "Account"}</p>
            {isAlreadyConnected ? (
              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                Already connected
              </span>
            ) : isMatched ? (
              <span className="text-xs bg-green-50 text-green-900 border border-green-300 px-2 py-0.5 rounded-full">
                IBAN Match
              </span>
            ) : null}
          </div>
          <p className="text-sm font-mono text-muted-foreground">{formatIban(account.iban)}</p>
          {isAlreadyConnected && selection.existingSourceName && (
            <p className="text-xs text-muted-foreground mt-1">
              Linked to: {selection.existingSourceName}
            </p>
          )}
        </div>
      </div>

      {/* Mode selection - only show for selected non-connected accounts */}
      {selection.selected && !isAlreadyConnected && (
        <div className="pl-7 space-y-3">
          <Select
            value={selection.mode === "link" ? `link:${selection.selectedSourceId}` : "create"}
            onValueChange={(value) => {
              if (value === "create") {
                onUpdate({ mode: "create", selectedSourceId: null });
              } else {
                const sourceId = value.replace("link:", "");
                onUpdate({ mode: "link", selectedSourceId: sourceId });
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="create">
                <div className="flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  Create new account
                </div>
              </SelectItem>
              {existingSources.length > 0 && (
                <>
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    Link to existing
                  </div>
                  {existingSources.map((source) => (
                    <SelectItem key={source.id} value={`link:${source.id}`}>
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4" />
                        <span>{source.name}</span>
                        {source.id === selection.matchedSourceId && (
                          <span className="text-xs text-green-600">(IBAN match)</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>

          {/* Name input for create mode */}
          {selection.mode === "create" && (
            <Input
              value={selection.newAccountName}
              onChange={(e) => onUpdate({ newAccountName: e.target.value })}
              placeholder="Account name"
            />
          )}

          {/* Info for link mode */}
          {selection.mode === "link" && selection.selectedSourceId && (
            <p className="text-xs text-muted-foreground">
              Transactions will sync to this existing account
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="container max-w-2xl mx-auto py-8">
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SelectAccountsPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SelectAccountsContent />
    </Suspense>
  );
}
