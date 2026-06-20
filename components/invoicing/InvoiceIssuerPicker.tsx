"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
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
 * Inline form for creating a new identity entity. Shown only when the user has
 * no entities at all (cold start).
 */
function InlineNewEntityForm({
  defaultName,
  onSaved,
  onCancel,
  saving,
  onSubmit,
}: {
  defaultName?: string;
  onSaved: (entityId: string, iban: string) => void;
  onCancel?: () => void;
  saving: boolean;
  onSubmit: (input: {
    name: string;
    iban: string;
    vatId?: string;
  }) => Promise<{ entityId: string; iban: string }>;
}) {
  const [name, setName] = useState(defaultName ?? "");
  const [iban, setIban] = useState("");
  const [vatId, setVatId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name ist erforderlich");
      return;
    }
    const normalizedIban = iban.replace(/\s+/g, "").toUpperCase();
    if (!normalizedIban) {
      setError("IBAN ist erforderlich");
      return;
    }
    try {
      const res = await onSubmit({
        name: name.trim(),
        iban: normalizedIban,
        vatId: vatId.trim() || undefined,
      });
      onSaved(res.entityId, res.iban);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    }
  };

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">
        Neue Bankverbindung (Absender)
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Name / Firma</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="z.B. Felix Häusler"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">IBAN</Label>
        <Input
          value={iban}
          onChange={(e) => setIban(e.target.value)}
          placeholder="AT00 0000 0000 0000 0000"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">UID (optional)</Label>
        <Input
          value={vatId}
          onChange={(e) => setVatId(e.target.value)}
          placeholder="ATU12345678"
        />
      </div>
      {error && <div className="text-xs text-destructive">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
            Abbrechen
          </Button>
        )}
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Speichern
        </Button>
      </div>
    </div>
  );
}

/**
 * Sub-form for appending an IBAN to an existing entity that has none yet.
 * Used when the user has identity configured (name + VAT etc.) but never
 * added a billing IBAN.
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
    addCompany,
    updatePersonalEntity,
    updateCompany,
  } = useUserData();
  const { sources } = useSources();
  const [showInlineForm, setShowInlineForm] = useState(false);

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

  // Auto-pick: prefer the first entity that has an IBAN available; fall back
  // to the first entity if none has one (so we still surface the "add IBAN"
  // sub-form for the most likely candidate).
  useEffect(() => {
    if (loading) return;
    if (value?.entityId) return;
    if (entities.length === 0) return;

    const preferred = entitiesWithIban[0] ?? entities[0];
    const ibans = ibansForEntity.get(preferred.id) ?? [];
    onChange({ entityId: preferred.id, iban: ibans[0] ?? "" });
  }, [loading, value?.entityId, entities, entitiesWithIban, ibansForEntity, onChange]);

  const handleEntityChange = (entityId: string) => {
    const e = entities.find((x) => x.id === entityId);
    if (!e) return;
    const ibans = ibansForEntity.get(e.id) ?? [];
    onChange({ entityId: e.id, iban: ibans[0] ?? "" });
  };

  const handleIbanChange = (iban: string) => {
    if (!selectedEntity) return;
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

  // Used only by the cold-start "no entities yet" path AND the "+ Weitere
  // Bankverbindung" trigger when we want a brand-new entity rather than
  // appending to an existing one.
  const submitNewEntity = async (input: {
    name: string;
    iban: string;
    vatId?: string;
  }): Promise<{ entityId: string; iban: string }> => {
    if (userData?.personalEntity) {
      const existingIbans = userData.personalEntity.ibans ?? [];
      const newIbans = existingIbans.includes(input.iban)
        ? existingIbans
        : [...existingIbans, input.iban];
      await updatePersonalEntity({
        name: input.name,
        ibans: newIbans,
        vatId: input.vatId ?? userData.personalEntity.vatId,
      });
      return { entityId: userData.personalEntity.id, iban: input.iban };
    }
    const id = await addCompany({
      name: input.name,
      aliases: [],
      ibans: [input.iban],
      vatId: input.vatId,
    });
    return { entityId: id, iban: input.iban };
  };

  const derivedBic = value?.iban ? bicFromIban(value.iban) : undefined;

  if (loading) {
    return <div className="text-sm text-muted-foreground">Lade Identität…</div>;
  }

  // Cold-start: no entities at all → inline create form is the primary surface.
  if (entities.length === 0) {
    return (
      <InlineNewEntityForm
        saving={saving}
        onSubmit={submitNewEntity}
        onSaved={(entityId, iban) => onChange({ entityId, iban })}
      />
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
      </div>

      {selectedEntity && hasIbans && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">IBAN</Label>
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
        <div className="text-xs text-muted-foreground space-y-0.5 pl-1">
          {selectedEntity.vatId && <div>UID: {selectedEntity.vatId}</div>}
          {derivedBic && <div>BIC: {derivedBic}</div>}
        </div>
      )}

      {/* Inline "add another bank account" trigger - creates a NEW entity */}
      {!disabled && !showInlineForm && hasIbans && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setShowInlineForm(true)}
        >
          <Plus className="h-3 w-3 mr-1" />
          Weitere Bankverbindung
        </Button>
      )}

      {showInlineForm && (
        <InlineNewEntityForm
          saving={saving}
          onSubmit={submitNewEntity}
          onCancel={() => setShowInlineForm(false)}
          onSaved={(entityId, iban) => {
            onChange({ entityId, iban });
            setShowInlineForm(false);
          }}
        />
      )}
    </div>
  );
}
