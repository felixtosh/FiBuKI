"use client";

/**
 * Sales at 0% on the UVA figure sheet (#565).
 *
 * A 0% rate alone does not say where a sale belongs. A B2B service supplied
 * abroad (§ 3a Abs 6) is not taxable in Austria and reaches no Kennzahl; an
 * export of goods stays in KZ 011. This renders three things off the run:
 *
 *  - the "Not taxable in Austria" line, EU and non-EU, with the sales behind
 *    each total, so the revenue that left the form is still visible;
 *  - the 0% sales still in KZ 011, with the undetermined ones flagged;
 *  - the Zusammenfassende Meldung due date, when EU services were performed
 *    in the period.
 *
 * Every row carries the override (service EU / non-EU / export of goods), the
 * income-side mirror of the purchase side's Goods/Service toggle.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SaleSupplyKind, UvaReportResult, ZeroRatedSaleEntry } from "@/functions/src/uva/types";
import { deriveFilingWarnings, deriveNotTaxableAbroad } from "@/functions/src/uva/filing";

const KINDS: SaleSupplyKind[] = ["service-eu", "service-non-eu", "export-goods"];

interface SaleSupplyReviewProps {
  result: UvaReportResult;
  /**
   * Writer for the person's answer (#565). The caller persists it
   * (updateTransaction callable) and recalculates the period. Absent, the
   * rows render read-only.
   */
  onSetSaleSupplyKind?: (transactionId: string, kind: SaleSupplyKind) => unknown;
}

function formatAmount(cents: number): string {
  return (cents / 100).toLocaleString("de-AT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function SaleSupplyReview({ result, onSetSaleSupplyKind }: SaleSupplyReviewProps) {
  const t = useTranslations("uvaReview.saleSupply");
  const notTaxable = deriveNotTaxableAbroad(result);
  const zm = deriveFilingWarnings(result).find((w) => w.code === "zm-due");
  const inKz011 = (result.zeroRatedSales ?? []).filter(
    (s) => s.kind === "export-goods" || s.kind === "undetermined"
  );

  // One row at a time: the period recalculates after every answer.
  const [savingFor, setSavingFor] = useState(NO_ROW);
  const setKind = async (transactionId: string, kind: SaleSupplyKind) => {
    if (!onSetSaleSupplyKind) return;
    setSavingFor(transactionId);
    try {
      await onSetSaleSupplyKind(transactionId, kind);
    } finally {
      setSavingFor(null);
    }
  };

  const row = (s: ZeroRatedSaleEntry) => (
    <div
      key={s.transactionId}
      className="flex flex-wrap items-center gap-2 py-1.5 px-2 text-sm border-b last:border-b-0"
    >
      <span className="w-24 font-mono text-xs text-muted-foreground">{s.date}</span>
      <span className="flex-1 min-w-24 truncate">{s.partner ?? "—"}</span>
      {s.customerVatId ? (
        <span className="font-mono text-xs text-muted-foreground">{s.customerVatId}</span>
      ) : null}
      <Badge variant={s.basis === "manual" ? "default" : "secondary"} className="text-xs">
        {t(`basis.${s.basis ?? "none"}`)}
      </Badge>
      {s.needsReview ? (
        <Badge variant="outline" className="text-xs border-amber-500 text-amber-700 dark:text-amber-400">
          {t("needsReview")}
        </Badge>
      ) : null}
      {onSetSaleSupplyKind ? (
        <span className="flex items-center gap-1">
          {KINDS.map((kind) => (
            <Button
              key={kind}
              variant={s.kind === kind && s.basis === "manual" ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={savingFor === s.transactionId}
              onClick={() => setKind(s.transactionId, kind)}
              title={t(`kindHint.${kind}`)}
            >
              {t(`kind.${kind}`)}
            </Button>
          ))}
        </span>
      ) : null}
      <span className="w-28 text-right font-mono tabular-nums">{formatAmount(s.net)} EUR</span>
    </div>
  );

  const group = (titleKey: "eu" | "nonEu", g: { total: number; sales: ZeroRatedSaleEntry[] }) => {
    if (g.sales.length === 0) return null;
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between px-2 text-sm font-medium">
          <span>{t(`notTaxable.${titleKey}`)}</span>
          <span className="font-mono tabular-nums">{formatAmount(g.total)} EUR</span>
        </div>
        {g.sales.map(row)}
      </div>
    );
  };

  const anyNotTaxable = notTaxable.eu.sales.length + notTaxable.nonEu.sales.length !== 0;

  return (
    <>
      {zm ? (
        <Card className="border-amber-500/60">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              {t("zm.title", { date: zm.dueDate ?? "" })}
            </CardTitle>
            <CardDescription>{t("zm.description", { count: zm.transactionIds.length })}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {anyNotTaxable ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("notTaxable.title")}</CardTitle>
            <CardDescription>{t("notTaxable.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {group("eu", notTaxable.eu)}
            {group("nonEu", notTaxable.nonEu)}
          </CardContent>
        </Card>
      ) : null}

      {inKz011.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("kz011.title", { count: inKz011.length })}</CardTitle>
            <CardDescription>{t("kz011.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">{inKz011.map(row)}</div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/** No row is being saved. A constant so the string lint (#168) does not read a generic as copy. */
const NO_ROW: string | null = null;
