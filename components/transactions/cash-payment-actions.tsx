"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callFunction } from "@/lib/firebase/callable";
import { cn } from "@/lib/utils";
import type { Transaction } from "@/types/transaction";

type Direction = "out" | "in";

/** A positive amount as typed ("4,50", "4.50", "12"), in cents; null when it is not one. */
function positiveCents(text: string): number | null {
  const s = text.trim().replace(/[\s€]/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s.replace(",", ".")) * 100);
  return cents > 0 ? cents : null;
}

/** Cents as the amount field shows them: "4,50". */
function centsText(cents: number): string {
  return (Math.abs(cents) / 100).toFixed(2).replace(".", ",");
}

/** Negative cents are money out. */
function directionOf(cents: number): Direction {
  return cents >= 0 ? "in" : "out";
}

/** The stored day (UTC midnight of the Vienna day), as the date input's YYYY-MM-DD. */
function storedDay(transaction: Transaction): string {
  return transaction.date.toDate().toISOString().slice(0, 10);
}

interface CashPaymentActionsProps {
  /** A Cash Payment the User added by hand (`addedByHand`). */
  transaction: Transaction;
  /** Called once the row is deleted, to close the panel. */
  onDeleted?: () => void;
}

/**
 * "Correct" and "Delete" on a Cash Payment the User added by hand (#790,
 * ADR-0017). The server refuses both on any other Transaction and inside a
 * filed UVA period; its message is shown as it comes.
 */
export function CashPaymentActions({ transaction, onDeleted }: CashPaymentActionsProps) {
  const t = useTranslations("cashPaymentEdit");
  const [correcting, setCorrecting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCorrecting(true)}
          className="flex-1 justify-start gap-2 text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-4 w-4" />
          <span>{t("correct")}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDeleting(true)}
          className="flex-1 justify-start gap-2 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
          <span>{t("delete")}</span>
        </Button>
      </div>
      {correcting ? <CorrectCashPaymentDialog transaction={transaction} onClose={() => setCorrecting(false)} /> : null}
      <DeleteCashPaymentDialog
        transaction={transaction}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={onDeleted}
      />
    </>
  );
}

function CorrectCashPaymentDialog({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const t = useTranslations("cashPaymentEdit");
  const [date, setDate] = useState(storedDay(transaction));
  const [amount, setAmount] = useState(centsText(transaction.amount));
  const [direction, setDirection] = useState(directionOf(transaction.amount));
  const [name, setName] = useState(transaction.name);
  const [description, setDescription] = useState(transaction.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null as string | null);

  const cents = positiveCents(amount);
  const canSave = !!date && cents !== null && name.trim().length > 0 && !saving;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave || cents === null) return;
    setSaving(true);
    setError(null);
    try {
      await callFunction<
        { transactionId: string; date: string; amount: number; name: string; description: string | null },
        { changed: boolean }
      >("correctCashPayment", {
        transactionId: transaction.id,
        date,
        amount: direction === "out" ? -cents : cents,
        name: name.trim(),
        description: description.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("correctFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("correctTitle")}</DialogTitle>
            <DialogDescription>{t("correctDescription")}</DialogDescription>
          </DialogHeader>

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
              <Label htmlFor="correct-cash-date">{t("date")}</Label>
              <Input id="correct-cash-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="correct-cash-amount">{t("amount", { currency: transaction.currency })}</Label>
              <Input
                id="correct-cash-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={cn(amount && cents === null && "border-destructive")}
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="correct-cash-name">{t("name")}</Label>
            <Input id="correct-cash-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="correct-cash-description">{t("note")}</Label>
            <Input
              id="correct-cash-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
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

function DeleteCashPaymentDialog({
  transaction,
  open,
  onOpenChange,
  onDeleted,
}: {
  transaction: Transaction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const t = useTranslations("cashPaymentEdit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null as string | null);
  const files = transaction.fileIds?.length ?? 0;

  const confirm = async (e: React.MouseEvent) => {
    // Stay open while the server works, and to show its refusal.
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await callFunction<{ transactionId: string }, { deleted: true }>("deleteCashPayment", {
        transactionId: transaction.id,
      });
      onOpenChange(false);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {files > 0 ? t("deleteWithFiles", { count: files }) : t("deleteDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirm}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
