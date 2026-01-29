"use client";

import { useState, useEffect, useMemo } from "react";
import { Save, Loader2, Plus, X, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useUserData } from "@/hooks/use-user-data";
import { useSources } from "@/hooks/use-sources";
import { UserDataFormData, TaxCountryCode } from "@/types/user-data";
import { useAuth } from "@/components/auth";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TAX_COUNTRIES: { value: TaxCountryCode; label: string; flag: string }[] = [
  { value: "AT", label: "Austria", flag: "🇦🇹" },
  { value: "DE", label: "Germany", flag: "🇩🇪" },
  { value: "CH", label: "Switzerland", flag: "🇨🇭" },
];

/**
 * Format Austrian tax number: 292090289 -> 29 209/0289
 */
function formatAustrianTaxNumber(value: string): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 2) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 2)} ${digits.slice(2)}`;
  return `${digits.slice(0, 2)} ${digits.slice(2, 5)}/${digits.slice(5, 9)}`;
}

export default function IdentityPage() {
  const { user } = useAuth();
  const { userData, loading: userDataLoading, saving, save, isConfigured } = useUserData();
  const { sources } = useSources();

  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [country, setCountry] = useState<TaxCountryCode>("AT");
  const [aliases, setAliases] = useState<string[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [vatIds, setVatIds] = useState<string[]>([]);
  const [newVatId, setNewVatId] = useState("");
  const [ibans, setIbans] = useState<string[]>([]);
  const [newIban, setNewIban] = useState("");
  const [ownEmails, setOwnEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  const inferredIbans = useMemo(() => {
    return sources
      .filter((s) => s.iban && s.accountKind === "bank_account")
      .map((s) => ({
        iban: s.iban!.toUpperCase().replace(/\s/g, ""),
        sourceName: s.name,
      }));
  }, [sources]);

  const inferredEmails = useMemo(() => {
    if (!user) return [];
    const emails = user.providerData
      .filter((p) => p.email)
      .map((p) => p.email!.toLowerCase());
    // Deduplicate
    return [...new Set(emails)];
  }, [user]);

  useEffect(() => {
    if (userData) {
      setName(userData.name || "");
      setCompanyName(userData.companyName || "");
      setCountry(userData.country || "AT");
      setAliases(userData.aliases || []);
      setVatIds(userData.vatIds || []);
      setIbans(userData.ibans || []);
      setOwnEmails(userData.ownEmails || []);
      setTaxNumber(userData.taxNumber || "");
    }
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
      country,
      aliases,
      vatIds,
      ibans,
      ownEmails,
      taxNumber: taxNumber || undefined,
    };
    await save(data);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const hasChanges =
    !userData ||
    name !== (userData?.name || "") ||
    companyName !== (userData?.companyName || "") ||
    country !== (userData?.country || "AT") ||
    taxNumber !== (userData?.taxNumber || "") ||
    JSON.stringify(aliases) !== JSON.stringify(userData?.aliases || []) ||
    JSON.stringify(vatIds) !== JSON.stringify(userData?.vatIds || []) ||
    JSON.stringify(ibans) !== JSON.stringify(userData?.ibans || []) ||
    JSON.stringify(ownEmails) !== JSON.stringify(userData?.ownEmails || []);

  return (
    <>
      <div className="mb-8">
        <h2 className="text-xl font-semibold">Your Identity</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Used for invoice classification and partner matching
        </p>
      </div>

      {userDataLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <div className="space-y-8" data-onboarding="identity-form">
          {/* Primary Info */}
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Your Name</Label>
              <Input
                id="name"
                placeholder="e.g., Felix Hausler"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="companyName">Company Name</Label>
              <Input
                id="companyName"
                placeholder="e.g., Infinity Vertigo GmbH"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
              />
            </div>
          </div>

          {/* Tax Country */}
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="country">Tax Residence Country</Label>
            <p className="text-sm text-muted-foreground">
              Determines tax forms and reporting formats
            </p>
            <Select value={country} onValueChange={(v) => setCountry(v as TaxCountryCode)}>
              <SelectTrigger id="country">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TAX_COUNTRIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    <span className="flex items-center gap-2">
                      <span>{c.flag}</span>
                      <span>{c.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Tax Number (FASTNR) - Austria only */}
          {country === "AT" && (
            <div className="space-y-2 max-w-xs">
              <Label htmlFor="taxNumber">Steuernummer</Label>
              <p className="text-sm text-muted-foreground">
                Required for FinanzOnline XML export
              </p>
              <Input
                id="taxNumber"
                placeholder="e.g., 29 209/0289"
                value={formatAustrianTaxNumber(taxNumber)}
                onChange={(e) => {
                  // Strip non-digits and limit to 9
                  const value = e.target.value.replace(/\D/g, "").slice(0, 9);
                  setTaxNumber(value);
                }}
                className="max-w-[180px] font-mono"
              />
              {taxNumber && taxNumber.length !== 9 && (
                <p className="text-sm text-amber-600">
                  Must be 9 digits (e.g., 29 209/0289)
                </p>
              )}
            </div>
          )}

          {/* Aliases */}
          <div className="space-y-3">
            <div>
              <Label>Aliases</Label>
              <p className="text-sm text-muted-foreground">
                Alternative spellings (e.g., umlauts)
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Add alias..."
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleAddAlias)}
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddAlias}
                disabled={!newAlias.trim()}
              >
                Add
              </Button>
            </div>
            {aliases.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {aliases.map((alias) => (
                  <Badge key={alias} variant="secondary" className="gap-1 pr-1">
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

          {/* VAT IDs */}
          <div className="space-y-3">
            <div>
              <Label>VAT IDs</Label>
              <p className="text-sm text-muted-foreground">
                Excluded from partner matching
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="e.g., ATU12345678"
                value={newVatId}
                onChange={(e) => setNewVatId(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleAddVatId)}
                className="max-w-xs font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddVatId}
                disabled={!newVatId.trim()}
              >
                Add
              </Button>
            </div>
            {vatIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {vatIds.map((vatId) => (
                  <Badge key={vatId} variant="secondary" className="gap-1 pr-1 font-mono">
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

          {/* IBANs */}
          <div className="space-y-3">
            <div>
              <Label>IBANs</Label>
              <p className="text-sm text-muted-foreground">
                Bank accounts auto-add their IBANs
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="e.g., AT12 3456 7890 1234 5678"
                value={newIban}
                onChange={(e) => setNewIban(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleAddIban)}
                className="max-w-sm font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddIban}
                disabled={!newIban.trim()}
              >
                Add
              </Button>
            </div>
            {(inferredIbans.length > 0 || ibans.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {inferredIbans.map(({ iban, sourceName }) => (
                  <Badge
                    key={iban}
                    variant="outline"
                    className="gap-1 font-mono text-muted-foreground"
                    title={`From: ${sourceName}`}
                  >
                    <Lock className="h-3 w-3" />
                    {iban}
                  </Badge>
                ))}
                {ibans.map((iban) => (
                  <Badge key={iban} variant="secondary" className="gap-1 pr-1 font-mono">
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

          {/* Emails */}
          <div className="space-y-3">
            <div>
              <Label>Email Addresses</Label>
              <p className="text-sm text-muted-foreground">
                Linked accounts auto-add their emails
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="e.g., info@company.de"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleAddEmail)}
                className="max-w-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddEmail}
                disabled={!newEmail.trim()}
              >
                Add
              </Button>
            </div>
            {(inferredEmails.length > 0 || ownEmails.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {inferredEmails.map((email) => (
                  <Badge
                    key={`inferred-${email}`}
                    variant="outline"
                    className="gap-1 font-mono text-muted-foreground"
                  >
                    <Lock className="h-3 w-3" />
                    {email}
                  </Badge>
                ))}
                {ownEmails.map((email) => (
                  <Badge key={`own-${email}`} variant="secondary" className="gap-1 pr-1 font-mono">
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

          {/* Save */}
          <div className="flex items-center gap-4 pt-6 border-t">
            <Button onClick={handleSave} disabled={saving || !hasChanges}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Changes
            </Button>
            {saveSuccess && (
              <span className="text-sm text-green-600">Saved!</span>
            )}
            {!isConfigured && (
              <span className="text-sm text-muted-foreground">
                Fill in your details to enable invoice matching
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
