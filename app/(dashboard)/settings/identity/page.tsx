"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Save, Loader2, Plus, Lock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { useUserData } from "@/hooks/use-user-data";
import { useSources } from "@/hooks/use-sources";
import { useOnboarding } from "@/hooks/use-onboarding";
import { IdentityEntityFormData, TaxCountryCode } from "@/types/user-data";
import { useAuth } from "@/components/auth";
import { generateEntityId } from "@/lib/operations";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";

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

/**
 * Create a default personal entity
 */
function createDefaultPersonalEntity(): IdentityEntityFormData {
  return {
    id: generateEntityId(),
    type: "person",
    name: "",
    aliases: [],
    vatId: "",
    ibans: [],
  };
}

/**
 * Create a default company entity
 */
function createDefaultCompany(): IdentityEntityFormData {
  return {
    id: generateEntityId(),
    type: "company",
    name: "",
    aliases: [],
    vatId: "",
    ibans: [],
  };
}

export default function IdentityPage() {
  const { user } = useAuth();
  const { userData, loading: userDataLoading, saving, save } = useUserData();
  const { sources } = useSources();
  const { isStepCompleted } = useOnboarding();
  const showIdentityHint = !isStepCompleted("set_identity");

  // Global settings
  const [country, setCountry] = useState<TaxCountryCode>("AT");
  const [taxNumber, setTaxNumber] = useState("");
  const [ownEmails, setOwnEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");

  // Entity state
  const [personalEntity, setPersonalEntity] = useState<IdentityEntityFormData>(
    createDefaultPersonalEntity()
  );
  const [companies, setCompanies] = useState<IdentityEntityFormData[]>([]);

  const [newAlias, setNewAlias] = useState("");
  const [newIban, setNewIban] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Inferred IBANs from bank accounts
  const inferredIbans = useMemo(() => {
    return sources
      .filter((s) => s.iban && s.accountKind === "bank_account")
      .map((s) => ({
        iban: s.iban!.toUpperCase().replace(/\s/g, ""),
        sourceName: s.name,
      }));
  }, [sources]);

  // Inferred emails from auth providers
  const inferredEmails = useMemo(() => {
    if (!user) return [];
    const emails = user.providerData
      .filter((p) => p.email)
      .map((p) => p.email!.toLowerCase());
    return [...new Set(emails)];
  }, [user]);

  // Load data from userData
  useEffect(() => {
    if (!userData) return;
    // Defer to microtask so setState runs event-handler-style, not from within the effect body.
    queueMicrotask(() => {
      setCountry(userData.country || "AT");
      setTaxNumber(userData.taxNumber || "");
      setOwnEmails(userData.ownEmails || []);

      // Load personal entity (with migration from old format)
      if (userData.personalEntity) {
        setPersonalEntity({
          id: userData.personalEntity.id,
          type: "person",
          name: userData.personalEntity.name || "",
          aliases: userData.personalEntity.aliases || [],
          vatId: userData.personalEntity.vatId || "",
          ibans: userData.personalEntity.ibans || [],
          address: userData.personalEntity.address,
          partnerId: userData.personalEntity.partnerId,
        });
      } else if (userData.name) {
        // Migrate from old format
        setPersonalEntity({
          id: generateEntityId(),
          type: "person",
          name: userData.name || "",
          aliases: userData.aliases || [],
          vatId: userData.vatIds?.[0] || "",
          ibans: userData.ibans || [],
          partnerId: userData.identityPartnerIds?.name,
        });
      }

      // Load companies
      if (userData.companies && userData.companies.length > 0) {
        setCompanies(
          userData.companies.map((c) => ({
            id: c.id,
            type: "company" as const,
            name: c.name || "",
            aliases: c.aliases || [],
            vatId: c.vatId || "",
            ibans: c.ibans || [],
            address: c.address,
            partnerId: c.partnerId,
          }))
        );
      } else if (userData.companyName) {
        // Migrate from old format
        setCompanies([
          {
            id: generateEntityId(),
            type: "company",
            name: userData.companyName,
            aliases: [],
            vatId: userData.vatIds?.[1] || "",
            ibans: [],
            partnerId: userData.identityPartnerIds?.companyName,
          },
        ]);
      }
    });
  }, [userData]);

  // Email management
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

  // Company management
  const handleUpdateCompany = (index: number, updates: Partial<IdentityEntityFormData>) => {
    const updated = [...companies];
    updated[index] = { ...updated[index], ...updates };
    setCompanies(updated);
  };

  const handleUpdatePersonal = (updates: Partial<IdentityEntityFormData>) => {
    setPersonalEntity({ ...personalEntity, ...updates });
  };

  // Merged aliases from personal + companies
  const allAliases = useMemo(() => {
    const combined = [...personalEntity.aliases];
    for (const c of companies) {
      for (const a of c.aliases) {
        if (!combined.includes(a)) combined.push(a);
      }
    }
    return combined;
  }, [personalEntity.aliases, companies]);

  const handleAddAlias = () => {
    const trimmed = newAlias.trim();
    if (trimmed && !allAliases.includes(trimmed)) {
      handleUpdatePersonal({ aliases: [...personalEntity.aliases, trimmed] });
      setNewAlias("");
    }
  };

  const handleRemoveAlias = (alias: string) => {
    handleUpdatePersonal({ aliases: personalEntity.aliases.filter((a) => a !== alias) });
    // Also remove from companies if present
    companies.forEach((c, i) => {
      if (c.aliases.includes(alias)) {
        handleUpdateCompany(i, { aliases: c.aliases.filter((a) => a !== alias) });
      }
    });
  };

  const handleAddIban = () => {
    const normalized = newIban.trim().toUpperCase().replace(/\s/g, "");
    if (
      normalized &&
      !personalEntity.ibans.includes(normalized) &&
      !inferredIbans.some((i) => i.iban === normalized)
    ) {
      handleUpdatePersonal({ ibans: [...personalEntity.ibans, normalized] });
      setNewIban("");
    }
  };

  // Save handler
  const handleSave = async () => {
    setSaveSuccess(false);
    await save({
      country,
      taxNumber: taxNumber || undefined,
      ownEmails,
      personalEntity,
      companies,
    });
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  // Change detection
  const hasChanges = useMemo(() => {
    if (!userData) return true;

    // Check global settings
    if (country !== (userData.country || "AT")) return true;
    if (taxNumber !== (userData.taxNumber || "")) return true;
    if (JSON.stringify(ownEmails) !== JSON.stringify(userData.ownEmails || [])) return true;

    // Check personal entity
    const originalPersonal = userData.personalEntity || {
      name: userData.name || "",
      aliases: userData.aliases || [],
      vatId: userData.vatIds?.[0] || "",
      ibans: userData.ibans || [],
    };
    if (personalEntity.name !== originalPersonal.name) return true;
    if (JSON.stringify(personalEntity.aliases) !== JSON.stringify(originalPersonal.aliases || [])) return true;
    if ((personalEntity.vatId || "") !== (originalPersonal.vatId || "")) return true;
    if (JSON.stringify(personalEntity.ibans) !== JSON.stringify(originalPersonal.ibans || [])) return true;
    if (JSON.stringify(personalEntity.address ?? null) !== JSON.stringify(userData.personalEntity?.address ?? null)) return true;

    // Check companies
    const originalCompanies = userData.companies || (userData.companyName ? [{
      name: userData.companyName,
      aliases: [],
      vatId: userData.vatIds?.[1] || "",
      ibans: [],
    }] : []);
    if (companies.length !== originalCompanies.length) return true;
    for (let i = 0; i < companies.length; i++) {
      const comp = companies[i];
      const orig = originalCompanies[i];
      if (comp.name !== (orig?.name || "")) return true;
      if (JSON.stringify(comp.aliases) !== JSON.stringify(orig?.aliases || [])) return true;
      if ((comp.vatId || "") !== (orig?.vatId || "")) return true;
      if (JSON.stringify(comp.ibans) !== JSON.stringify(orig?.ibans || [])) return true;
    }

    return false;
  }, [userData, country, taxNumber, ownEmails, personalEntity, companies]);

  return (
    <div className="pb-16">
      <SettingsPageHeader
        title="Your Identity"
        description="Manage your personal and business identities for invoice matching"
      />

      {showIdentityHint && (
        <div className="mt-4 mb-2 flex items-start gap-3 rounded-lg border border-info-border bg-info px-4 py-3">
          <p className="flex-1 text-sm text-info-foreground">
            Fill in as much detail as you can — your name, company, VAT ID, and email addresses help our automation identify invoices addressed to you or issued by you.
          </p>
          <Info className="h-5 w-5 flex-shrink-0 text-info-foreground animate-info-icon-in" />
        </div>
      )}

      {userDataLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="space-y-8">
          {/* Tax Country + Tax Number (two-column) */}
          <div className="grid grid-cols-2 gap-6 max-w-lg">
            <div className="space-y-2">
              <Label htmlFor="country">Tax Residence Country</Label>
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

            {country === "AT" && (
              <div className="space-y-2">
                <Label htmlFor="taxNumber">Steuernummer</Label>
                <Input
                  id="taxNumber"
                  placeholder="e.g., 29 209/0289"
                  value={formatAustrianTaxNumber(taxNumber)}
                  onChange={(e) => {
                    const value = e.target.value.replace(/\D/g, "").slice(0, 9);
                    setTaxNumber(value);
                  }}
                  className="font-mono"
                />
                {taxNumber && taxNumber.length !== 9 && (
                  <p className="text-sm text-amber-600">
                    Must be 9 digits
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Emails */}
          <div className="space-y-3">
            <div>
              <Label className="text-base">Email Addresses</Label>
              <p className="text-sm text-muted-foreground">
                Your email addresses (linked accounts auto-add their emails)
              </p>
            </div>
            <div className="flex gap-2 max-w-sm">
              <Input
                placeholder="e.g., info@company.de"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, handleAddEmail)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddEmail}
                disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim())}
              >
                Add
              </Button>
            </div>
            {(inferredEmails.length > 0 || ownEmails.length > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {inferredEmails.map((email) => (
                  <Pill
                    key={`inferred-${email}`}
                    label={email}
                    icon={Lock}
                    className="font-mono"
                  />
                ))}
                {ownEmails.map((email) => (
                  <Pill
                    key={`own-${email}`}
                    label={email}
                    className="font-mono"
                    onRemove={() => handleRemoveEmail(email)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Identity */}
          <div className="space-y-6 rounded-lg border p-6" data-onboarding="identity-form">
            {/* Name + Company Name */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="personal-name">Your Name</Label>
                <Input
                  id="personal-name"
                  placeholder="Your full name"
                  value={personalEntity.name}
                  onChange={(e) => handleUpdatePersonal({ name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company-name">Company Name</Label>
                <Input
                  id="company-name"
                  placeholder="Optional"
                  value={companies[0]?.name ?? ""}
                  onChange={(e) => {
                    if (companies.length === 0) {
                      setCompanies([{ ...createDefaultCompany(), name: e.target.value }]);
                    } else {
                      handleUpdateCompany(0, { name: e.target.value });
                    }
                  }}
                />
              </div>
            </div>

            {/* VAT IDs */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="personal-vat">Personal VAT ID</Label>
                <Input
                  id="personal-vat"
                  placeholder="e.g., ATU12345678"
                  value={personalEntity.vatId || ""}
                  onChange={(e) => handleUpdatePersonal({ vatId: e.target.value })}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company-vat">Company VAT ID</Label>
                <Input
                  id="company-vat"
                  placeholder="e.g., ATU12345678"
                  value={companies[0]?.vatId ?? ""}
                  onChange={(e) => {
                    if (companies.length === 0) {
                      setCompanies([{ ...createDefaultCompany(), vatId: e.target.value }]);
                    } else {
                      handleUpdateCompany(0, { vatId: e.target.value });
                    }
                  }}
                  className="font-mono"
                />
              </div>
            </div>

            {/* Aliases */}
            <div className="space-y-2">
              <Label>Aliases</Label>
              <p className="text-xs text-muted-foreground">
                Other names you or your company appear as on invoices
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Add alias..."
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddAlias(); } }}
                  className="flex-1"
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
              {allAliases.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {allAliases.map((alias) => (
                    <Pill
                      key={alias}
                      label={alias}
                      onRemove={() => handleRemoveAlias(alias)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* IBANs */}
            <div className="space-y-2">
              <Label>IBANs</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g., AT12 3456 7890 1234 5678"
                  value={newIban}
                  onChange={(e) => setNewIban(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddIban(); } }}
                  className="flex-1 font-mono"
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
              {(() => {
                // Dedupe: if a manual IBAN is also present in inferredIbans
                // (from a connected bank account in /sources), hide the
                // manual pill and let the inferred (source-derived) pill be
                // the only one shown. Avoids the duplicate-IBAN UI the user
                // saw after adding a bank account whose IBAN they'd also
                // typed manually.
                const inferredSet = new Set(inferredIbans.map((i) => i.iban));
                const manualOnly = personalEntity.ibans.filter(
                  (iban) => !inferredSet.has(iban)
                );
                if (inferredIbans.length === 0 && manualOnly.length === 0) return null;
                return (
                  <div className="flex flex-wrap gap-1.5">
                    {inferredIbans.map(({ iban }) => (
                      <Pill
                        key={iban}
                        label={iban}
                        icon={Lock}
                        className="font-mono"
                      />
                    ))}
                    {manualOnly.map((iban) => (
                      <Pill
                        key={iban}
                        label={iban}
                        className="font-mono"
                        onRemove={() => handleUpdatePersonal({ ibans: personalEntity.ibans.filter((i) => i !== iban) })}
                      />
                    ))}
                  </div>
                );
              })()}
            </div>

            {/* Address (shown on issued invoices) */}
            <div className="space-y-2">
              <Label>Address</Label>
              <p className="text-xs text-muted-foreground">
                Appears as the sender block on your invoices.
              </p>
              <Input
                placeholder="Street and number"
                value={personalEntity.address?.street ?? ""}
                onChange={(e) =>
                  handleUpdatePersonal({
                    address: { ...(personalEntity.address ?? {}), street: e.target.value },
                  })
                }
              />
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <Input
                  placeholder="Postal code"
                  value={personalEntity.address?.postalCode ?? ""}
                  onChange={(e) =>
                    handleUpdatePersonal({
                      address: { ...(personalEntity.address ?? {}), postalCode: e.target.value },
                    })
                  }
                />
                <Input
                  placeholder="City"
                  value={personalEntity.address?.city ?? ""}
                  onChange={(e) =>
                    handleUpdatePersonal({
                      address: { ...(personalEntity.address ?? {}), city: e.target.value },
                    })
                  }
                />
              </div>
              <Input
                placeholder="Country (e.g., AT)"
                value={personalEntity.address?.country ?? ""}
                onChange={(e) =>
                  handleUpdatePersonal({
                    address: {
                      ...(personalEntity.address ?? {}),
                      country: e.target.value.toUpperCase().slice(0, 2),
                    },
                  })
                }
                className="font-mono uppercase"
                maxLength={2}
              />
            </div>
          </div>

        </div>
      )}

      {/* Sticky save bar */}
      {!userDataLoading && (
        <div className="sticky bottom-0 -mx-8 px-8 py-3 mt-6 bg-background border-t shadow-[0_-2px_8px_rgba(0,0,0,0.05)] flex items-center gap-4">
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
        </div>
      )}
    </div>
  );
}
