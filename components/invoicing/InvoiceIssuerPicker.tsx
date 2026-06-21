"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, Settings } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useUserData } from "@/hooks/use-user-data";
import { useSources } from "@/hooks/use-sources";
import { IdentityEntity } from "@/types/user-data";
import { bicFromIban } from "@/lib/invoicing/bicLookup";

export interface SelectedIssuer {
  entityId: string;
  iban: string;
}

interface InvoiceIssuerPickerProps {
  value?: SelectedIssuer | null;
  onChange: (selection: SelectedIssuer) => void;
  disabled?: boolean;
}

function getEntities(
  personal: IdentityEntity | undefined,
  companies: IdentityEntity[] | undefined
): IdentityEntity[] {
  const list: IdentityEntity[] = [];
  if (personal) list.push(personal);
  if (companies) list.push(...companies);
  return list;
}

/**
 * Sub-form for appending an IBAN to an existing entity that has none yet.
 * Used when the user has identity configured (name + VAT etc.) but never
 * added a billing IBAN. Anything bigger (new entity, address, VAT) routes
 * to /settings/identity — this picker is a pure selector + IBAN-enrichment
 * affordance.
 */
function InlineAddIbanForm({
  entityName,
  saving,
  onSave,
}: {
  entityName: string;
  saving: boolean;
  onSave: (iban: string) => Promise<void>;
}) {
  const [iban, setIban] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    const normalized = iban.replace(/\s+/g, "").toUpperCase();
    if (!normalized) {
      setError("IBAN ist erforderlich");
      return;
    }
    try {
      await onSave(normalized);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        IBAN für {entityName} hinzufügen
      </Label>
      <div className="flex gap-2">
        <Input
          value={iban}
          onChange={(e) => setIban(e.target.value)}
          placeholder="AT00 0000 0000 0000 0000"
          className="flex-1"
        />
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            "Speichern"
          )}
        </Button>
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}

export function InvoiceIssuerPicker({
  value,
  onChange,
  disabled = false,
}: InvoiceIssuerPickerProps) {
  const {
    userData,
    loading,
    saving,
    updatePersonalEntity,
    updateCompany,
  } = useUserData();
  const { sources } = useSources();

  // Show ALL entities (including those without an IBAN). When the user picks
  // an IBAN-less entity, we render an inline "add IBAN" form below the
  // selector instead of hiding the entity.
  const entities = useMemo(
    () =>
      getEntities(userData?.personalEntity, userData?.companies).filter(
        (e) => !!e.name
      ),
    [userData]
  );

  // Inferred IBANs from bank account sources. The identity settings UI shows
  // these as read-only pills but they're NOT persisted into any entity. We
  // still want to offer them as billing IBAN options on invoices, attached to
  // the personal entity by default (since they belong to the user themselves
  // - the user owns the bank account regardless of which legal entity issues
  // the invoice).
  const inferredIbansFromSources = useMemo(() => {
    return sources
      .filter((s) => s.iban && s.accountKind === "bank_account")
      .map((s) => s.iban!.toUpperCase().replace(/\s/g, ""));
  }, [sources]);

  // Map each entity to its effective IBAN list (own + inferred for personal).
  // For non-personal entities, inferred IBANs are NOT auto-attached because
  // we don't know which company owns which account.
  const ibansForEntity = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const e of entities) {
      const own = e.ibans ?? [];
      if (e.type === "person") {
        // Merge inferred IBANs (dedup, own first)
        const merged = [...own];
        for (const inf of inferredIbansFromSources) {
          if (!merged.includes(inf)) merged.push(inf);
        }
        map.set(e.id, merged);
      } else {
        map.set(e.id, own);
      }
    }
    return map;
  }, [entities, inferredIbansFromSources]);

  // Entity with at least one IBAN available (own or inferred-for-personal).
  const entitiesWithIban = useMemo(
    () => entities.filter((e) => (ibansForEntity.get(e.id)?.length ?? 0) > 0),
    [entities, ibansForEntity]
  );

  const selectedEntity = useMemo(
    () => entities.find((e) => e.id === value?.entityId) ?? null,
    [entities, value?.entityId]
  );

  // Persist an IBAN onto an entity's `ibans` array if it isn't already
  // listed. This "promotes" inferred-from-sources IBANs into the user's
  // identity so backend validation (updateInvoice) passes — it requires the
  // chosen IBAN to live on the entity. No-op if the IBAN is already owned.
  const persistIbanIfInferred = async (
    entity: IdentityEntity,
    iban: string
  ): Promise<boolean> => {
    if (!iban) return true;
    const ownIbans = entity.ibans ?? [];
    if (ownIbans.includes(iban)) return true;
    try {
      const nextIbans = [...ownIbans, iban];
      if (entity.type === "person") {
        await updatePersonalEntity({ ibans: nextIbans });
      } else {
        await updateCompany(entity.id, { ibans: nextIbans });
      }
      return true;
    } catch (err) {
      console.error("Failed to persist inferred IBAN to entity:", err);
      return false;
    }
  };

  // Auto-pick: prefer the first entity that has an IBAN available; fall back
  // to the first entity if none has one (so we still surface the "add IBAN"
  // sub-form for the most likely candidate).
  useEffect(() => {
    if (loading) return;
    if (value?.entityId) return;
    if (entities.length === 0) return;

    const preferred = entitiesWithIban[0] ?? entities[0];
    const ibans = ibansForEntity.get(preferred.id) ?? [];
    const ibanToPick = ibans[0] ?? "";
    const ownIbans = preferred.ibans ?? [];
    if (ibanToPick && !ownIbans.includes(ibanToPick)) {
      // Auto-pick landed on an inferred IBAN — persist it first, then fire
      // onChange so the parent picks up the entity+iban together.
      (async () => {
        const ok = await persistIbanIfInferred(preferred, ibanToPick);
        if (ok) onChange({ entityId: preferred.id, iban: ibanToPick });
      })();
    } else {
      onChange({ entityId: preferred.id, iban: ibanToPick });
    }
  }, [loading, value?.entityId, entities, entitiesWithIban, ibansForEntity, onChange]);

  const handleEntityChange = async (entityId: string) => {
    const e = entities.find((x) => x.id === entityId);
    if (!e) return;
    const ibans = ibansForEntity.get(e.id) ?? [];
    const ibanToPick = ibans[0] ?? "";
    if (ibanToPick) {
      const ok = await persistIbanIfInferred(e, ibanToPick);
      if (!ok) return;
    }
    onChange({ entityId: e.id, iban: ibanToPick });
  };

  const handleIbanChange = async (iban: string) => {
    if (!selectedEntity) return;
    // If the picked IBAN isn't already on the entity, it came from the
    // inferred-from-sources list. The backend updateInvoice validates that
    // the chosen IBAN lives on the entity's `ibans` array, so we have to
    // persist it first — otherwise the next autosave fails with
    // "issuerIban does not belong to entity" / "Issuer entity not found".
    const ok = await persistIbanIfInferred(selectedEntity, iban);
    if (!ok) return;
    onChange({ entityId: selectedEntity.id, iban });
  };

  // Append an IBAN to whichever entity is currently selected.
  const appendIbanToSelectedEntity = async (newIban: string) => {
    if (!selectedEntity) return;
    const existing = selectedEntity.ibans ?? [];
    const nextIbans = existing.includes(newIban)
      ? existing
      : [...existing, newIban];

    if (selectedEntity.type === "person") {
      await updatePersonalEntity({ ibans: nextIbans });
    } else {
      await updateCompany(selectedEntity.id, { ibans: nextIbans });
    }
    onChange({ entityId: selectedEntity.id, iban: newIban });
  };

  const derivedBic = value?.iban ? bicFromIban(value.iban) : undefined;

  if (loading) {
    return <div className="text-sm text-muted-foreground">Lade Identität…</div>;
  }

  // Cold-start: no entities at all → route the user to settings/identity. The
  // invoice picker no longer creates identity entities itself (single source
  // of truth lives in /settings/identity).
  if (entities.length === 0) {
    return (
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <div className="text-sm font-medium">Absender fehlt</div>
        <p className="text-xs text-muted-foreground">
          Lege deine Firmen-/Personendaten in den Einstellungen unter
          „Identität" an, dann kannst du Rechnungen ausstellen.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link href="/settings/identity">
            <Settings className="h-3.5 w-3.5 mr-1.5" />
            Identität einrichten
          </Link>
        </Button>
      </div>
    );
  }

  const availableIbans = selectedEntity
    ? ibansForEntity.get(selectedEntity.id) ?? []
    : [];
  const hasIbans = availableIbans.length > 0;

  // Detect cross-entity IBANs we could offer as a fallback hint when the
  // current entity has none.
  const otherEntityWithIban = entitiesWithIban.find(
    (e) => e.id !== selectedEntity?.id
  );

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Absender</Label>
        {entities.length === 1 ? (
          // Single entity — render as static text. A dropdown with one option
          // is just noise.
          <div className="text-sm px-3 py-2 rounded-md border bg-muted/30">
            {entities[0].name}
            {entities[0].type === "company" ? " (Firma)" : ""}
          </div>
        ) : (
          <Select
            value={value?.entityId ?? ""}
            onValueChange={handleEntityChange}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder="Identität wählen" />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => {
                const ibanCount = ibansForEntity.get(e.id)?.length ?? 0;
                return (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                    {e.type === "company" ? " (Firma)" : ""}
                    {ibanCount === 0 ? " — keine IBAN" : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>

      {selectedEntity && hasIbans && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs text-muted-foreground">IBAN</Label>
            {!disabled && (
              <Link
                href="/sources"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                title="Konten in neuem Tab bearbeiten"
              >
                <ExternalLink className="h-3 w-3" />
                Bearbeiten
              </Link>
            )}
          </div>
          <Select
            value={value?.iban ?? ""}
            onValueChange={handleIbanChange}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder="IBAN wählen" />
            </SelectTrigger>
            <SelectContent>
              {availableIbans.map((iban) => (
                <SelectItem key={iban} value={iban}>
                  {iban}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Selected entity has no IBAN yet → prompt to add one, plus hint if
          another entity has IBANs the user might have intended. */}
      {selectedEntity && !hasIbans && !disabled && (
        <>
          {otherEntityWithIban && (
            <button
              type="button"
              onClick={() => handleEntityChange(otherEntityWithIban.id)}
              className="text-xs text-primary hover:underline text-left"
            >
              IBAN von „{otherEntityWithIban.name}" verwenden
            </button>
          )}
          <InlineAddIbanForm
            entityName={selectedEntity.name}
            saving={saving}
            onSave={appendIbanToSelectedEntity}
          />
        </>
      )}

      {selectedEntity && (
        <div className="text-xs text-muted-foreground pl-1 flex items-start justify-between gap-2">
          <div className="space-y-0.5 min-w-0 flex-1">
            {selectedEntity.vatId && <div>UID: {selectedEntity.vatId}</div>}
            {derivedBic && <div>BIC: {derivedBic}</div>}
          </div>
          {!disabled && (
            <Link
              href="/settings/identity"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline flex-shrink-0"
              title="Identität in neuem Tab bearbeiten"
            >
              <ExternalLink className="h-3 w-3" />
              Bearbeiten
            </Link>
          )}
        </div>
      )}

    </div>
  );
}
