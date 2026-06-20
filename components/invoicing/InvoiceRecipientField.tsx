"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AddPartnerDialog } from "@/components/partners/add-partner-dialog";
import { PartnerPill } from "@/components/partners/partner-pill";
import { usePartners } from "@/hooks/use-partners";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { PartnerFormData } from "@/types/partner";

export interface SelectedRecipient {
  partnerId: string;
  partnerType: "user" | "global";
}

interface InvoiceRecipientFieldProps {
  value?: SelectedRecipient | null;
  onChange: (selection: SelectedRecipient | null) => void;
  disabled?: boolean;
}

/**
 * Recipient picker for invoices. Reuses the standard partner chip + AddPartnerDialog
 * pattern from the file detail panel rather than maintaining a bespoke combobox.
 *
 * Behavior:
 * - No recipient selected → "Add" button opens AddPartnerDialog.
 * - Recipient selected → PartnerPill with X to remove.
 * - Creating a new partner goes through the standard usePartners().createPartner
 *   flow (with skipAutoMatch since we're assigning immediately).
 */
export function InvoiceRecipientField({
  value,
  onChange,
  disabled = false,
}: InvoiceRecipientFieldProps) {
  const { partners: userPartners, createPartner } = usePartners();
  const { globalPartners } = useGlobalPartners();
  const [dialogOpen, setDialogOpen] = useState(false);

  const selected = useMemo(() => {
    if (!value) return null;
    if (value.partnerType === "user") {
      return userPartners.find((p) => p.id === value.partnerId) ?? null;
    }
    return globalPartners.find((p) => p.id === value.partnerId) ?? null;
  }, [value, userPartners, globalPartners]);

  const handleAdd = useCallback(
    async (data: PartnerFormData) => {
      const partnerId = await createPartner(data, { skipAutoMatch: true });
      onChange({ partnerId, partnerType: "user" });
      return partnerId;
    },
    [createPartner, onChange]
  );

  const handleSelectExisting = useCallback(
    (partnerId: string, partnerType: "user" | "global") => {
      onChange({ partnerId, partnerType });
    },
    [onChange]
  );

  const handleRemove = useCallback(() => {
    onChange(null);
  }, [onChange]);

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">Rechnung an</Label>
      <div>
        {selected ? (
          <PartnerPill
            name={selected.name}
            partnerType={value!.partnerType}
            onRemove={disabled ? undefined : handleRemove}
            disabled={disabled}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialogOpen(true)}
            className="h-7 px-3"
            disabled={disabled}
          >
            <Plus className="h-3 w-3 mr-1" />
            Empfänger wählen
          </Button>
        )}
      </div>

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

      <AddPartnerDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdd={handleAdd}
        onSelectPartner={handleSelectExisting}
        userPartners={userPartners}
        globalPartners={globalPartners}
      />
    </div>
  );
}
