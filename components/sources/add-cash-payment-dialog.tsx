"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callFunction } from "@/lib/firebase/callable";
import { usePartners } from "@/hooks/use-partners";
import { cn } from "@/lib/utils";
import type { CashPaymentDefaults } from "@/functions/src/transactions/cashPaymentDefaults";

type Direction = "out" | "in";

interface AddCashPaymentDialogProps {
  open: boolean;
  onClose: () => void;
  /** The Cash Box the payment goes to. From a File, `cashBoxes` offers it instead. */
  sourceId?: string;
  currency: string;
  /** Called with the new Transaction's id once it is stored. */
  onAdded?: (transactionId: string) => void;
  /**
   * From a File (#789): the File the payment is for, and its figures the
   * form opens with for the User to check. The saved row is connected to it.
   */
  fromFile?: { fileId: string; defaults: CashPaymentDefaults };
  /** From a File: the User's Cash Boxes. One is chosen, several are asked, none is created on save. */
  cashBoxes?: CashBoxChoice[];
}

export interface CashBoxChoice {
  id: string;
  name: string;
  currency: string;
}

const NO_PARTNER = "__none__";

/** Today in Vienna, as the date input's YYYY-MM-DD. */
function viennaToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Vienna" });
}

/** A positive amount as typed ("4,50", "4.50", "12"), in cents; null when it is not one. */
function positiveCents(text: string): number | null {
  const s = text.trim().replace(/[\s€]/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s.replace(",", ".")) * 100);
  return cents > 0 ? cents : null;
}

/** Positive cents as the amount input shows them: 900 is "9,00". */
function centsText(cents: number | null): string {
  return cents === null ? "" : (Math.abs(cents) / 100).toFixed(2).replace(".", ",");
}

/**
 * Add one Cash Payment by hand (#788): the day, a positive amount with money
 * out or money in (out preselected), the User's own text and an optional
 * Partner. The server stores it as signed cents on UTC midnight of the day.
 */
export function AddCashPaymentDialog({
  open,
  onClose,
  sourceId,
  currency,
  onAdded,
  fromFile,
  cashBoxes,
}: AddCashPaymentDialogProps) {
  const t = useTranslations("sources.cashPayment");
  const { partners } = usePartners();
  const start = fromFile?.defaults;
  const startDirection = Math.sign(start?.amount ?? -1) === 1 ? ("in" as Direction) : ("out" as Direction);
  const boxes = fromFile ? (cashBoxes ?? []) : [];

  const [date, setDate] = useState(start?.date ?? viennaToday());
  const [amount, setAmount] = useState(centsText(start?.amount ?? null));
  const [direction, setDirection] = useState(startDirection);
  const [name, setName] = useState(start?.name ?? "");
  const [partnerId, setPartnerId] = useState(start?.partnerId ?? NO_PARTNER);
  const [boxId, setBoxId] = useState(boxes.length === 1 ? boxes[0].id : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = positiveCents(amount);
  // From a File: one Cash Box is chosen, several wait for the User's pick, none is created on save.
  const boxReady = !fromFile || boxes.length === 0 || !!boxId;
  const canSave = !!date && cents !== null && name.trim().length > 0 && boxReady && !saving;

  const reset = () => {
    setDate(start?.date ?? viennaToday());
    setAmount(centsText(start?.amount ?? null));
    setDirection(startDirection);
    setName(start?.name ?? "");
    setPartnerId(start?.partnerId ?? NO_PARTNER);
    setBoxId(boxes.length === 1 ? boxes[0].id : "");
    setError(null);
  };

  /** The User's first Cash Box, through the create-source callable (#789). */
  const createFirstCashBox = async () => {
    const created = await callFunction<{ data: Record<string, unknown> }, { sourceId: string }>("createSource", {
      data: { name: t("defaultCashBoxName"), accountKind: "cash", currency, type: "manual" },
    });
    setBoxId(created.sourceId);
    return created.sourceId;
  };

  const close = () => {
    reset();
    onClose();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave || cents === null) return;
    setSaving(true);
    setError(null);
    try {
      const payment = {
        date,
        amount: direction === "out" ? -cents : cents,
        name: name.trim(),
        ...(partnerId !== NO_PARTNER ? { partnerId } : {}),
      };
      const result = fromFile
        ? await callFunction<Record<string, unknown>, { transactionId: string }>("addCashPaymentFromFile", {
            fileId: fromFile.fileId,
            sourceId: boxId || (await createFirstCashBox()),
            ...payment,
          })
        : await callFunction<
            { sourceId?: string; date: string; amount: number; name: string; partnerId?: string },
            { transactionId: string }
          >("addCashPayment", { sourceId, ...payment });
      onAdded?.(result.transactionId);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{fromFile ? t("fromFileTitle") : t("title")}</DialogTitle>
            <DialogDescription>{fromFile ? t("fromFileDescription") : t("description")}</DialogDescription>
          </DialogHeader>

          {fromFile && boxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noCashBox", { name: t("defaultCashBoxName") })}</p>
          ) : null}
          {boxes.length > 1 ? (
            <div className="space-y-1.5">
              <Label>{t("cashBox")}</Label>
              <Select value={boxId} onValueChange={setBoxId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("chooseCashBox")} />
                </SelectTrigger>
                <SelectContent>
                  {boxes.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex gap-2" role="radiogroup" aria-label={t("direction")}>
            {(["out", "in"] as const).map((d) => (
              <Button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                variant={direction === d ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => setDirection(d)}
              >
                {d === "out" ? t("moneyOut") : t("moneyIn")}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cash-payment-date">{t("date")}</Label>
              <Input id="cash-payment-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cash-payment-amount">{t("amount", { currency })}</Label>
              <Input
                id="cash-payment-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={t("amountPlaceholder")}
                className={cn(amount && cents === null && "border-destructive")}
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cash-payment-name">{t("name")}</Label>
            <Input
              id="cash-payment-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("partner")}</Label>
            <Select value={partnerId} onValueChange={setPartnerId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PARTNER}>{t("noPartner")}</SelectItem>
                {partners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
