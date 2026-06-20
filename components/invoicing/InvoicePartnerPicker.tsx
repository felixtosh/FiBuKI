/**
 * @deprecated Superseded by InvoiceRecipientField, which reuses the standard
 * PartnerPill + AddPartnerDialog pattern from the file detail panel. Kept in
 * the tree only so any external callers don't break; remove once nothing
 * imports it.
 */
"use client";

import { useMemo, useState } from "react";
import {
  Building2,
  Check,
  ChevronsUpDown,
  Globe,
  Loader2,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { usePartners } from "@/hooks/use-partners";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { cn } from "@/lib/utils";

export interface SelectedPartner {
  partnerId: string;
  partnerType: "user" | "global";
}

interface InvoicePartnerPickerProps {
  value?: SelectedPartner | null;
  onChange: (selection: SelectedPartner) => void;
  disabled?: boolean;
  label?: string;
}

type CombinedPartner = (UserPartner | GlobalPartner) & {
  partnerType: "user" | "global";
};

export function InvoicePartnerPicker({
  value,
  onChange,
  disabled = false,
  label = "Rechnung an",
}: InvoicePartnerPickerProps) {
  const { partners: userPartners, createPartner } = usePartners();
  const { globalPartners } = useGlobalPartners();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [newVatId, setNewVatId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const startCreate = (prefill?: string) => {
    setNewName(prefill ?? search);
    setNewVatId("");
    setCreateError(null);
    setCreateMode(true);
  };

  const handleCreate = async () => {
    setCreateError(null);
    const name = newName.trim();
    if (!name) {
      setCreateError("Name ist erforderlich");
      return;
    }
    setCreating(true);
    try {
      const partnerId = await createPartner(
        {
          name,
          vatId: newVatId.trim() || undefined,
        },
        { skipAutoMatch: true }
      );
      onChange({ partnerId, partnerType: "user" });
      setCreateMode(false);
      setOpen(false);
      setSearch("");
      setNewName("");
      setNewVatId("");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  };

  const combined = useMemo<CombinedPartner[]>(() => {
    const localizedGlobalIds = new Set(
      userPartners
        .filter((p) => p.globalPartnerId)
        .map((p) => p.globalPartnerId!)
    );
    const filteredGlobals = globalPartners.filter(
      (g) => !localizedGlobalIds.has(g.id)
    );
    return [
      ...userPartners.map((p) => ({ ...p, partnerType: "user" as const })),
      ...filteredGlobals.map((p) => ({
        ...p,
        partnerType: "global" as const,
      })),
    ];
  }, [userPartners, globalPartners]);

  const filtered = useMemo(() => {
    if (!search.trim()) return combined.slice(0, 50);
    const q = search.toLowerCase();
    return combined.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.vatId?.toLowerCase().includes(q) ||
        p.website?.toLowerCase().includes(q) ||
        p.aliases?.some((a) => a.toLowerCase().includes(q))
    );
  }, [combined, search]);

  const selected = useMemo<CombinedPartner | null>(() => {
    if (!value) return null;
    return (
      combined.find(
        (p) => p.id === value.partnerId && p.partnerType === value.partnerType
      ) ?? null
    );
  }, [combined, value]);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            {selected ? selected.name : "Partner wählen…"}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
        >
          <div className="p-2 border-b">
            <Input
              placeholder="Partner suchen…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8"
              autoFocus
            />
          </div>
          {createMode ? (
            <div className="p-3 space-y-2">
              <div className="text-xs text-muted-foreground">Neuen Partner anlegen</div>
              <div className="space-y-1.5">
                <Label className="text-xs">Name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Firmenname oder Person"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">UID (optional)</Label>
                <Input
                  value={newVatId}
                  onChange={(e) => setNewVatId(e.target.value)}
                  placeholder="ATU12345678"
                />
              </div>
              {createError && (
                <div className="text-xs text-destructive">{createError}</div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCreateMode(false)}
                  disabled={creating}
                >
                  Abbrechen
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={creating}>
                  {creating && (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  )}
                  Anlegen
                </Button>
              </div>
            </div>
          ) : (
            <ScrollArea className="h-[260px]">
              {filtered.length === 0 ? (
                <div className="p-2 space-y-1">
                  <div className="px-2 py-3 text-sm text-muted-foreground text-center">
                    Keine Partner gefunden.
                  </div>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent cursor-pointer text-left"
                    onClick={() => startCreate(search)}
                  >
                    <Plus className="h-4 w-4 text-muted-foreground" />
                    <span>
                      Neuen Partner
                      {search.trim() ? ` "${search.trim()}"` : ""} anlegen
                    </span>
                  </button>
                </div>
              ) : (
                <div className="p-1">
                  {filtered.map((p) => {
                    const isSelected =
                      selected?.id === p.id &&
                      selected?.partnerType === p.partnerType;
                    return (
                      <button
                        key={`${p.partnerType}-${p.id}`}
                        type="button"
                        className={cn(
                          "w-full flex items-start gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent cursor-pointer text-left",
                          isSelected && "bg-accent"
                        )}
                        onClick={() => {
                          onChange({
                            partnerId: p.id,
                            partnerType: p.partnerType,
                          });
                          setOpen(false);
                          setSearch("");
                        }}
                      >
                        <Check
                          className={cn(
                            "mt-0.5 h-4 w-4 flex-shrink-0",
                            isSelected ? "opacity-100" : "opacity-0"
                          )}
                        />
                        {p.partnerType === "global" ? (
                          <Globe className="mt-0.5 h-4 w-4 text-blue-500 flex-shrink-0" />
                        ) : (
                          <Building2 className="mt-0.5 h-4 w-4 text-muted-foreground flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{p.name}</p>
                          <div className="text-xs text-muted-foreground">
                            {p.vatId && (
                              <p className="truncate">VAT: {p.vatId}</p>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  <div className="border-t mt-1 pt-1">
                    <button
                      type="button"
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent cursor-pointer text-left text-muted-foreground"
                      onClick={() => startCreate(search)}
                    >
                      <Plus className="h-4 w-4" />
                      <span>Neuen Partner anlegen</span>
                    </button>
                  </div>
                </div>
              )}
            </ScrollArea>
          )}
        </PopoverContent>
      </Popover>

      {/* Show selected partner details */}
      {selected && (
        <div className="text-xs text-muted-foreground space-y-0.5 pl-1">
          {selected.address?.street && <div>{selected.address.street}</div>}
          {(selected.address?.postalCode || selected.address?.city) && (
            <div>
              {[selected.address?.postalCode, selected.address?.city]
                .filter(Boolean)
                .join(" ")}
            </div>
          )}
          {selected.address?.country && <div>{selected.address.country}</div>}
          {selected.vatId && <div>UID: {selected.vatId}</div>}
        </div>
      )}
    </div>
  );
}
