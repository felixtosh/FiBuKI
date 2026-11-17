"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Money out (negative cents) or money in (positive). */
export type CashPaymentDirection = "out" | "in";

/**
 * A positive amount as typed ("4,50", "4.50", "12"), in cents; null when it
 * is not one. Stricter than the CSV import's `parseAmount`, which strips any
 * character it does not know and reads a point as a thousands separator
 * under German rules: here a typo must show as one, not become a figure.
 */
export function positiveCents(text: string): number | null {
  const s = text.trim().replace(/[\s€]/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s.replace(",", ".")) * 100);
  return cents > 0 ? cents : null;
}

/** Cents as the amount field shows them, without the sign: -450 is "4,50". */
export function centsText(cents: number | null): string {
  return cents === null ? "" : (Math.abs(cents) / 100).toFixed(2).replace(".", ",");
}

/** The direction signed cents carry: negative is money out, none yet is out. */
export function directionOf(cents: number | null | undefined): CashPaymentDirection {
  return (cents ?? -1) >= 0 ? "in" : "out";
}

/** Signed cents from a positive amount and its direction. */
export function signedCents(cents: number, direction: CashPaymentDirection): number {
  return direction === "out" ? -cents : cents;
}

interface CashPaymentFieldsProps {
  /** Prefix of the inputs' ids, unique per form. */
  idPrefix: string;
  currency: string;
  date: string;
  onDateChange: (date: string) => void;
  /** The amount as typed, positive. */
  amount: string;
  onAmountChange: (amount: string) => void;
  direction: CashPaymentDirection;
  onDirectionChange: (direction: CashPaymentDirection) => void;
  name: string;
  onNameChange: (name: string) => void;
}

/**
 * The fields a Cash Payment is typed with, adding one or correcting it:
 * money out or in, the day, a positive amount and the User's own text.
 */
export function CashPaymentFields({
  idPrefix,
  currency,
  date,
  onDateChange,
  amount,
  onAmountChange,
  direction,
  onDirectionChange,
  name,
  onNameChange,
}: CashPaymentFieldsProps) {
  const t = useTranslations("sources.cashPayment");
  const invalidAmount = amount !== "" && positiveCents(amount) === null;

  return (
    <>
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
            onClick={() => onDirectionChange(d)}
          >
            {d === "out" ? t("moneyOut") : t("moneyIn")}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-date`}>{t("date")}</Label>
          <Input
            id={`${idPrefix}-date`}
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-amount`}>{t("amount", { currency })}</Label>
          <Input
            id={`${idPrefix}-amount`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder={t("amountPlaceholder")}
            className={cn(invalidAmount && "border-destructive")}
            required
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-name`}>{t("name")}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t("namePlaceholder")}
          required
        />
      </div>
    </>
  );
}
