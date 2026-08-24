"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { callFunction } from "@/lib/firebase/callable";
import {
  BillingDocumentExpectation,
  DeclaredBillingCycle,
  UserPartner,
} from "@/types/partner";
import { CADENCE_DAYS } from "@/lib/partners/billing-cycle-presentation";

const CADENCES = ["weekly", "monthly", "quarterly", "yearly", "custom"] as const;
type Cadence = (typeof CADENCES)[number];

const EXPECTATIONS: BillingDocumentExpectation[] = [
  "invoice",
  "no-receipt-category",
  "nothing",
];

/** A declared recurrence while it is being edited: every field a string. */
interface CycleDraft {
  cadence: Cadence;
  frequencyDays: string;
  amountMin: string;
  amountMax: string;
  currency: string;
  documentExpectation: BillingDocumentExpectation;
}

function emptyDraft(): CycleDraft {
  return {
    cadence: "monthly",
    frequencyDays: "30",
    amountMin: "",
    amountMax: "",
    currency: "EUR",
    documentExpectation: "invoice",
  };
}

/**
 * Cents, from what the operator typed in euros. `undefined` for an empty
 * field — the amount band is optional — and `null` for something that is not
 * a non-negative number, which is a mistake worth reporting rather than
 * dropping.
 */
function parseAmount(value: string): number | null | undefined {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function toDraft(declared: DeclaredBillingCycle): CycleDraft {
  // Exact match only. `cadenceOf` reads 31 days as monthly, which is right on
  // screen and wrong in an editor: re-saving would silently rewrite the
  // declaration to 30.
  const named = (Object.keys(CADENCE_DAYS) as Array<keyof typeof CADENCE_DAYS>).find(
    (name) => CADENCE_DAYS[name] === declared.frequencyDays,
  );
  return {
    cadence: named ?? "custom",
    frequencyDays: String(declared.frequencyDays),
    amountMin: declared.expectedAmountMin !== undefined
      ? String(declared.expectedAmountMin / 100)
      : "",
    amountMax: declared.expectedAmountMax !== undefined
      ? String(declared.expectedAmountMax / 100)
      : "",
    currency: declared.currency || "EUR",
    documentExpectation: declared.documentExpectation ?? "invoice",
  };
}

interface BillingCycleDialogProps {
  partner: UserPartner;
  open: boolean;
  onClose: () => void;
}

/**
 * The declared half of a partner's billing cycle, edited by hand.
 *
 * The whole declared array is submitted at once, because that is what the
 * declare path takes: it replaces the declared half wholesale and re-resolves
 * the effective view. Editing one recurrence of a two-band partner therefore
 * has to carry the other one along, which is why the rows are edited together
 * rather than one at a time.
 *
 * Nothing here writes to Firestore. `setPartnerBillingCycle` delegates to the
 * same handler `set_partner_billing_cycle` runs, so a declaration made here
 * and one made by a script are parsed, validated and stored identically.
 */
export function BillingCycleDialog({ partner, open, onClose }: BillingCycleDialogProps) {
  const t = useTranslations("billingCycle");
  const [drafts, setDrafts] = useState<CycleDraft[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening after a change elsewhere (a script, another tab) must show what
  // is stored now, not what was on screen last time.
  useEffect(() => {
    if (!open) return;
    const declared = partner.billingCycle?.declared ?? [];
    setDrafts(declared.length > 0 ? declared.map(toDraft) : [emptyDraft()]);
    setError(null);
  }, [open, partner.billingCycle]);

  const updateDraft = (index: number, patch: Partial<CycleDraft>) => {
    setDrafts((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    );
  };

  const submit = async (declared: unknown) => {
    setIsSaving(true);
    setError(null);
    try {
      await callFunction("setPartnerBillingCycle", {
        partnerId: partner.id,
        declared,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => {
    const declared: Record<string, unknown>[] = [];
    for (const draft of drafts) {
      const frequencyDays =
        draft.cadence === "custom"
          ? Number(draft.frequencyDays.trim())
          : CADENCE_DAYS[draft.cadence];
      if (!Number.isFinite(frequencyDays) || frequencyDays <= 0) {
        setError(t("errors.frequency"));
        return;
      }

      const expectedAmountMin = parseAmount(draft.amountMin);
      const expectedAmountMax = parseAmount(draft.amountMax);
      if (expectedAmountMin === null || expectedAmountMax === null) {
        setError(t("errors.amount"));
        return;
      }
      if (
        expectedAmountMin !== undefined &&
        expectedAmountMax !== undefined &&
        expectedAmountMin > expectedAmountMax
      ) {
        setError(t("errors.amountOrder"));
        return;
      }
      // More than one recurrence is told apart by its amount band, and the
      // declare path refuses two it cannot tell apart.
      if (
        drafts.length > 1 &&
        (expectedAmountMin === undefined || expectedAmountMax === undefined)
      ) {
        setError(t("errors.bandRequired"));
        return;
      }

      declared.push({
        frequencyDays: Math.round(frequencyDays),
        ...(expectedAmountMin !== undefined ? { expectedAmountMin } : {}),
        ...(expectedAmountMax !== undefined ? { expectedAmountMax } : {}),
        ...(draft.currency.trim() ? { currency: draft.currency.trim().toUpperCase() } : {}),
        documentExpectation: draft.documentExpectation,
      });
    }

    void submit(declared);
  };

  const hasDeclaration = (partner.billingCycle?.declared?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialog.title")}</DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
          {drafts.map((draft, index) => (
            <div key={index} className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("dialog.recurrence", { index: index + 1 })}
                </span>
                {drafts.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() =>
                      setDrafts((current) => current.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("dialog.cadence")}</Label>
                  <Select
                    value={draft.cadence}
                    onValueChange={(value) =>
                      updateDraft(index, { cadence: value as Cadence })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CADENCES.map((cadence) => (
                        <SelectItem key={cadence} value={cadence}>
                          {cadence === "custom"
                            ? t("dialog.customCadence")
                            : t(`cadence.${cadence}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {draft.cadence === "custom" && (
                  <div className="space-y-1.5">
                    <Label>{t("dialog.frequencyDays")}</Label>
                    <Input
                      type="number"
                      min={1}
                      value={draft.frequencyDays}
                      onChange={(e) =>
                        updateDraft(index, { frequencyDays: e.target.value })
                      }
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("dialog.amountMin")}</Label>
                  <Input
                    inputMode="decimal"
                    placeholder="0,00"
                    value={draft.amountMin}
                    onChange={(e) => updateDraft(index, { amountMin: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("dialog.amountMax")}</Label>
                  <Input
                    inputMode="decimal"
                    placeholder="0,00"
                    value={draft.amountMax}
                    onChange={(e) => updateDraft(index, { amountMax: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("dialog.currency")}</Label>
                  <Input
                    maxLength={3}
                    value={draft.currency}
                    onChange={(e) => updateDraft(index, { currency: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{t("dialog.expectation")}</Label>
                <Select
                  value={draft.documentExpectation}
                  onValueChange={(value) =>
                    updateDraft(index, {
                      documentExpectation: value as BillingDocumentExpectation,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPECTATIONS.map((expectation) => (
                      <SelectItem key={expectation} value={expectation}>
                        {t(`expectation.${expectation}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setDrafts((current) => [...current, emptyDraft()])}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("dialog.addRecurrence")}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter className="gap-2 sm:justify-between">
          {hasDeclaration ? (
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={isSaving}
              onClick={() => void submit(null)}
            >
              {t("dialog.clear")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={isSaving}>
              {t("dialog.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={isSaving || drafts.length === 0}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("dialog.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
