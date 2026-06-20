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
 * Inline form for creating a new identity entity (or appending an IBAN to an
 * existing one). Used when the user has no identity yet, or when they want
 * to add a new sender bank account without leaving the invoice editor.
 */
function InlineEntityForm({
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

export function InvoiceIssuerPicker({
  value,
  onChange,
  disabled = false,
}: InvoiceIssuerPickerProps) {
  const { userData, loading, saving, addCompany, updatePersonalEntity } =
    useUserData();
  const [showInlineForm, setShowInlineForm] = useState(false);

  const entities = useMemo(
    () =>
      getEntities(userData?.personalEntity, userData?.companies).filter(
        (e) => e.name && e.ibans && e.ibans.length > 0
      ),
    [userData]
  );

  const selectedEntity = useMemo(
    () => entities.find((e) => e.id === value?.entityId) ?? null,
    [entities, value?.entityId]
  );

  // Auto-pick first entity + first IBAN when nothing selected yet
  useEffect(() => {
    if (loading) return;
    if (!value?.entityId && entities.length > 0) {
      const first = entities[0];
      if (first.ibans[0]) {
        onChange({ entityId: first.id, iban: first.ibans[0] });
      }
    }
  }, [loading, value?.entityId, entities, onChange]);

  const handleEntityChange = (entityId: string) => {
    const e = entities.find((x) => x.id === entityId);
    if (!e) return;
    onChange({ entityId: e.id, iban: e.ibans[0] ?? "" });
  };

  const handleIbanChange = (iban: string) => {
    if (!selectedEntity) return;
    onChange({ entityId: selectedEntity.id, iban });
  };

  // Create-or-append: if user has a personal entity already, add the IBAN to
  // it. Otherwise spin up a new company entity.
  const submitNewIssuer = async (input: {
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

  // No identity yet → inline form is the primary surface
  if (entities.length === 0) {
    return (
      <InlineEntityForm
        saving={saving}
        onSubmit={submitNewIssuer}
        onSaved={(entityId, iban) => onChange({ entityId, iban })}
      />
    );
  }

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
            {entities.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
                {e.type === "company" ? " (Firma)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedEntity && selectedEntity.ibans.length > 0 && (
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
              {selectedEntity.ibans.map((iban) => (
                <SelectItem key={iban} value={iban}>
                  {iban}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {selectedEntity && (
        <div className="text-xs text-muted-foreground space-y-0.5 pl-1">
          {selectedEntity.vatId && <div>UID: {selectedEntity.vatId}</div>}
          {derivedBic && <div>BIC: {derivedBic}</div>}
        </div>
      )}

      {/* Inline "add another bank account" trigger */}
      {!disabled && !showInlineForm && (
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
        <InlineEntityForm
          saving={saving}
          onSubmit={submitNewIssuer}
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
