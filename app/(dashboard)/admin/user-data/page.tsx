"use client";

import { useState, useEffect, useMemo } from "react";
import { Save, Loader2, Plus, X, Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Alert,
  AlertDescription,
} from "@/components/ui/alert";
import { useUserData } from "@/hooks/use-user-data";
import { useSources } from "@/hooks/use-sources";
import { useEmailIntegrations } from "@/hooks/use-email-integrations";
import { UserDataFormData } from "@/types/user-data";

export default function AdminUserDataPage() {
  const { userData, loading, saving, save, isConfigured } = useUserData();
  const { sources } = useSources();
  const { integrations } = useEmailIntegrations();

  // Form state
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [vatIds, setVatIds] = useState<string[]>([]);
  const [newVatId, setNewVatId] = useState("");
  const [ibans, setIbans] = useState<string[]>([]);
  const [newIban, setNewIban] = useState("");
  const [ownEmails, setOwnEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Get IBANs from connected bank accounts (inferred, non-editable)
  const inferredIbans = useMemo(() => {
    return sources
      .filter((s) => s.iban && s.accountKind === "bank_account")
      .map((s) => ({
        iban: s.iban!.toUpperCase().replace(/\s/g, ""),
        sourceName: s.name,
      }));
  }, [sources]);

  // Get emails from connected email integrations (inferred, non-editable)
  const inferredEmails = useMemo(() => {
    return integrations
      .filter((i) => i.email)
      .map((i) => i.email.toLowerCase());
  }, [integrations]);

  // Populate form when data loads
  useEffect(() => {
    if (!userData) return;
    // Defer to microtask so setState runs event-handler-style, not from within the effect body.
    queueMicrotask(() => {
      setName(userData.name || "");
      setCompanyName(userData.companyName || "");
      setAliases(userData.aliases || []);
      setVatIds(userData.vatIds || []);
      setIbans(userData.ibans || []);
      setOwnEmails(userData.ownEmails || []);
    });
  }, [userData]);

  const handleAddAlias = () => {
    const trimmed = newAlias.trim();
    if (trimmed && !aliases.includes(trimmed)) {
      setAliases([...aliases, trimmed]);
      setNewAlias("");
    }
  };

  const handleRemoveAlias = (alias: string) => {
    setAliases(aliases.filter((a) => a !== alias));
  };

  const handleAddVatId = () => {
    const normalized = newVatId.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized && !vatIds.includes(normalized)) {
      setVatIds([...vatIds, normalized]);
      setNewVatId("");
    }
  };

  const handleRemoveVatId = (vatId: string) => {
    setVatIds(vatIds.filter((v) => v !== vatId));
  };

  const handleAddIban = () => {
    const normalized = newIban.trim().toUpperCase().replace(/\s/g, "");
    // Check it's not already in manual list or inferred list
    if (
      normalized &&
      !ibans.includes(normalized) &&
      !inferredIbans.some((i) => i.iban === normalized)
    ) {
      setIbans([...ibans, normalized]);
      setNewIban("");
    }
  };

  const handleRemoveIban = (iban: string) => {
    setIbans(ibans.filter((i) => i !== iban));
  };

  const handleAddEmail = () => {
    const normalized = newEmail.trim().toLowerCase();
    // Check it's not already in manual list or inferred list
    if (
      normalized &&
      !ownEmails.includes(normalized) &&
      !inferredEmails.includes(normalized)
    ) {
      setOwnEmails([...ownEmails, normalized]);
      setNewEmail("");
    }
  };

  const handleRemoveEmail = (email: string) => {
    setOwnEmails(ownEmails.filter((e) => e !== email));
  };

  const handleKeyDown = (e: React.KeyboardEvent, handler: () => void) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handler();
    }
  };

  const handleSave = async () => {
    setSaveSuccess(false);
    const data: UserDataFormData = {
      name,
      companyName,
      aliases,
      vatIds,
      ibans,
      ownEmails,
    };
    await save(data);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const hasChanges =
    !userData ||
    name !== (userData?.name || "") ||
    companyName !== (userData?.companyName || "") ||
    JSON.stringify(aliases) !== JSON.stringify(userData?.aliases || []) ||
    JSON.stringify(vatIds) !== JSON.stringify(userData?.vatIds || []) ||
    JSON.stringify(ibans) !== JSON.stringify(userData?.ibans || []) ||
    JSON.stringify(ownEmails) !== JSON.stringify(userData?.ownEmails || []);

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold">User Data</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure your identity for invoice classification and extraction
          </p>
        </div>

        {/* Info Alert */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            This data helps determine if an invoice is <strong>incoming</strong> (you are the recipient)
            or <strong>outgoing</strong> (you are the issuer). The extracted partner will be compared
            against your name, company, and aliases.
          </AlertDescription>
        </Alert>

        {/* Form Card */}
        <Card>
          <CardHeader>
            <CardTitle>Your Identity</CardTitle>
            <CardDescription>
              Enter your name and company details. These will be used during file extraction.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {loading ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : (
              <>
                {/* Name Field */}
                <div className="space-y-2">
                  <Label htmlFor="name">Your Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., Felix Häusler"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Your full name as it appears on invoices
                  </p>
                </div>

                {/* Company Name Field */}
                <div className="space-y-2">
                  <Label htmlFor="companyName">Company Name</Label>
                  <Input
                    id="companyName"
                    placeholder="e.g., Infinity Vertigo GmbH"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Your company name as it appears on invoices
                  </p>
                </div>

                {/* Aliases Field */}
                <div className="space-y-2">
                  <Label>Aliases</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g., Haeusler (for umlauts)"
                      value={newAlias}
                      onChange={(e) => setNewAlias(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleAddAlias)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleAddAlias}
                      disabled={!newAlias.trim()}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Alternative spellings or variations of your name/company (e.g., without umlauts)
                  </p>
                  {aliases.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {aliases.map((alias) => (
                        <Badge
                          key={alias}
                          variant="secondary"
                          className="flex items-center gap-1 pr-1"
                        >
                          {alias}
                          <button
                            type="button"
                            onClick={() => handleRemoveAlias(alias)}
                            className="ml-1 hover:bg-muted rounded-full p-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {/* VAT IDs Field */}
                <div className="space-y-2">
                  <Label>Your VAT IDs</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g., ATU12345678"
                      value={newVatId}
                      onChange={(e) => setNewVatId(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleAddVatId)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleAddVatId}
                      disabled={!newVatId.trim()}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your company VAT ID(s). These will be excluded from partner matching.
                  </p>
                  {vatIds.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {vatIds.map((vatId) => (
                        <Badge
                          key={vatId}
                          variant="secondary"
                          className="flex items-center gap-1 pr-1 font-mono"
                        >
                          {vatId}
                          <button
                            type="button"
                            onClick={() => handleRemoveVatId(vatId)}
                            className="ml-1 hover:bg-muted rounded-full p-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {/* IBANs Field */}
                <div className="space-y-2">
                  <Label>Your IBANs</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g., AT12 3456 7890 1234 5678"
                      value={newIban}
                      onChange={(e) => setNewIban(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleAddIban)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleAddIban}
                      disabled={!newIban.trim()}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your bank account IBANs. IBANs from connected bank accounts are added automatically.
                  </p>
                  {/* Inferred IBANs from sources (non-editable) */}
                  {inferredIbans.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {inferredIbans.map(({ iban, sourceName }) => (
                        <Badge
                          key={iban}
                          variant="outline"
                          className="flex items-center gap-1 font-mono text-muted-foreground"
                          title={`From: ${sourceName}`}
                        >
                          <Lock className="h-3 w-3 mr-1" />
                          {iban}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {/* Manual IBANs (editable) */}
                  {ibans.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {ibans.map((iban) => (
                        <Badge
                          key={iban}
                          variant="secondary"
                          className="flex items-center gap-1 pr-1 font-mono"
                        >
                          {iban}
                          <button
                            type="button"
                            onClick={() => handleRemoveIban(iban)}
                            className="ml-1 hover:bg-muted rounded-full p-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {/* Own Emails Field */}
                <div className="space-y-2">
                  <Label>Your Email Addresses</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g., info@mycompany.de"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, handleAddEmail)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleAddEmail}
                      disabled={!newEmail.trim()}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your email addresses. Connected Gmail accounts are added automatically.
                    Used to identify outgoing emails and prevent false partner matches.
                  </p>
                  {/* Inferred emails from email integrations (non-editable) */}
                  {inferredEmails.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {inferredEmails.map((email) => (
                        <Badge
                          key={email}
                          variant="outline"
                          className="flex items-center gap-1 font-mono text-muted-foreground"
                        >
                          <Lock className="h-3 w-3 mr-1" />
                          {email}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {/* Manual emails (editable) */}
                  {ownEmails.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {ownEmails.map((email) => (
                        <Badge
                          key={email}
                          variant="secondary"
                          className="flex items-center gap-1 pr-1 font-mono"
                        >
                          {email}
                          <button
                            type="button"
                            onClick={() => handleRemoveEmail(email)}
                            className="ml-1 hover:bg-muted rounded-full p-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {/* Save Button */}
                <div className="flex items-center gap-4 pt-4 border-t">
                  <Button
                    onClick={handleSave}
                    disabled={saving || !hasChanges}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    Save Changes
                  </Button>
                  {saveSuccess && (
                    <span className="text-sm text-green-600 dark:text-green-400">
                      Saved successfully!
                    </span>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Status */}
        {!loading && (
          <div className="text-sm text-muted-foreground">
            Status:{" "}
            {isConfigured ? (
              <span className="text-green-600 dark:text-green-400">Configured</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">Not configured</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
