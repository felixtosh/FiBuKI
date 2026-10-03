"use client";

/**
 * Each Invoice Correction in a UVA period and how its figure was derived
 * (#564, story 50): the original, what it claimed, the fraction this refund
 * is of it, what earlier refunds took back, and what this one reverses.
 * Renders nothing for a period without corrections.
 */

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileMinus, TriangleAlert } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { CorrectionEntry, CorrectionRateGroup } from "@/functions/src/uva/types";

function vatOf(groups: CorrectionRateGroup[]): number {
  return groups.reduce((s, g) => s + g.vat, 0);
}

export function UvaCorrections({ corrections }: { corrections: CorrectionEntry[] }) {
  const t = useTranslations("uvaReview.corrections");
  if (corrections.length === 0) return null;
  return (
    <section className="space-y-2 px-3" data-testid="uva-corrections">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-xs text-muted-foreground">{t("explanation")}</p>
      <ul className="space-y-2">
        {corrections.map((c) => (
          <CorrectionLine key={c.transactionId} c={c} />
        ))}
      </ul>
    </section>
  );
}

function CorrectionLine({ c }: { c: CorrectionEntry }) {
  const t = useTranslations("uvaReview.corrections");
  const refund = Math.abs(c.amount);
  const claimedVat = vatOf(c.claimed);
  const correctedVat = vatOf(c.corrected);
  const priorVat = vatOf(c.priorCorrected);
  const percent = c.originalGross > 0 ? `${((refund / c.originalGross) * 100).toFixed(1)}%` : "—";
  return (
    <li className="rounded border p-2 text-xs space-y-0.5">
      <div className="flex items-center gap-2 text-sm">
        <FileMinus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <Link href={`/transactions?id=${c.transactionId}`} className="truncate hover:underline">
          {[c.date, c.partner].filter(Boolean).join(" · ")}
        </Link>
        <span className="text-muted-foreground">{t(c.side === "purchase-correction" ? "purchase" : "sale")}</span>
        <span className="ml-auto tabular-nums">{formatCurrency(c.amount)}</span>
      </div>
      {c.status === "linked" && c.originalFileId ? (
        <p className="text-muted-foreground">
          <Link href={`/files?id=${c.originalFileId}`} className="hover:underline">
            {t("original")}
          </Link>
          {" · "}
          {t("paidBy", { count: c.paidByTransactionIds.length })}
          {" · "}
          {t(c.side === "purchase-correction" ? "claimed" : "owed", {
            vat: formatCurrency(claimedVat),
            gross: formatCurrency(c.originalGross),
          })}
          {" · "}
          {t("fraction", { percent })}
          {priorVat > 0 ? ` · ${t("prior", { vat: formatCurrency(priorVat) })}` : null}
          {" · "}
          {claimedVat > 0 ? t("reverses", { vat: formatCurrency(correctedVat) }) : t("nothing")}
        </p>
      ) : null}
      {c.status === "unlinked" ? (
        <p className="text-destructive">{t(c.unlinkedReason === "original-unpaid" ? "unpaid" : "unlinked")}</p>
      ) : null}
      {c.excessVat > 0 ? <p className="text-destructive">{t("excess", { vat: formatCurrency(c.excessVat) })}</p> : null}
      {c.printedVatMismatch && c.printedVat !== null ? (
        <p className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
          <TriangleAlert className="h-3 w-3 mt-0.5 shrink-0" />
          {t("printedMismatch", {
            printed: formatCurrency(c.printedVat),
            computed: formatCurrency(vatOf(c.corrected) + c.excessVat),
          })}
        </p>
      ) : null}
    </li>
  );
}
