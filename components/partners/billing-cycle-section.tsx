"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { CalendarClock, Pencil, Repeat } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldRow, SectionHeader } from "@/components/ui/detail-panel-primitives";
import { DeclaredBillingCycle, UserPartner } from "@/types/partner";
import { usePartnerBillingCycle, type RecurrenceView } from "@/hooks/use-partner-billing-cycle";
import {
  cadenceOf,
  chargeWindowState,
  coverageState,
  declarationFor,
} from "@/lib/partners/billing-cycle-presentation";
import { BillingCycleDialog } from "./billing-cycle-dialog";

/** Coverage reads as an outcome, so its tone is the badge variant it earns. */
const COVERAGE_VARIANT = {
  complete: "success",
  partial: "warning",
  none: "warning",
  empty: "muted",
} as const;

const WINDOW_VARIANT = {
  upcoming: "muted",
  due: "info",
  overdue: "warning",
  unknown: "muted",
} as const;

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: currency || "EUR",
  }).format(cents / 100);
}

function formatDay(date: Date): string {
  return format(date, "MMM d, yyyy");
}

/**
 * What the recurrence is expected to cost: the declared band's edges when
 * there are any, otherwise the nominal amount the band is keyed by.
 */
function describeExpectedAmount(
  declaration: DeclaredBillingCycle | null,
  amountBand: number | undefined,
  currency: string,
): string | null {
  const min = declaration?.expectedAmountMin;
  const max = declaration?.expectedAmountMax;
  if (min !== undefined && max !== undefined) {
    return `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`;
  }
  if (min !== undefined) return formatMoney(min, currency);
  if (max !== undefined) return formatMoney(max, currency);
  if (declaration?.amountBand !== undefined) {
    return formatMoney(declaration.amountBand, currency);
  }
  if (amountBand !== undefined) return formatMoney(amountBand, currency);
  return null;
}

interface BillingCycleSectionProps {
  partner: UserPartner;
}

/**
 * The billing cycle where the partner lives (#170).
 *
 * Read-only for the learned half — only Fibuki writes that — and an editor for
 * the declared one, which goes out through the callable that delegates to
 * `set_partner_billing_cycle`, the same path a script takes.
 */
export function BillingCycleSection({ partner }: BillingCycleSectionProps) {
  const t = useTranslations("billingCycle");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const { isRecurring, recurrences, coverageMonths, loading } =
    usePartnerBillingCycle(partner);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeader>{t("title")}</SectionHeader>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setIsEditOpen(true)}
        >
          <Pencil className="h-3 w-3 mr-1" />
          {partner.billingCycle?.declared?.length ? t("edit") : t("declare")}
        </Button>
      </div>

      {!isRecurring ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <div className="space-y-4">
          {recurrences.map((recurrence, index) => (
            <RecurrenceCard
              key={`${recurrence.band.amountBand ?? "single"}-${index}`}
              partner={partner}
              recurrence={recurrence}
              coverageMonths={coverageMonths}
            />
          ))}
        </div>
      )}

      <BillingCycleDialog
        partner={partner}
        open={isEditOpen}
        onClose={() => setIsEditOpen(false)}
      />
    </div>
  );
}

function RecurrenceCard({
  partner,
  recurrence,
  coverageMonths,
}: {
  partner: UserPartner;
  recurrence: RecurrenceView;
  coverageMonths: number;
}) {
  const t = useTranslations("billingCycle");
  const { band, lastCharge, nextExpected, coverage } = recurrence;

  const cadence = cadenceOf(band.frequencyDays);
  const declaration = declarationFor(partner.billingCycle?.declared, band);
  const windowState = chargeWindowState(nextExpected, new Date());
  const coverageLevel = coverageState(coverage);

  // The band was learned from account-currency amounts, so that is what an
  // expected amount without a declared currency is stated in.
  const bandCurrency =
    declaration?.currency || lastCharge?.accountCurrency || "EUR";
  const expectedAmount = describeExpectedAmount(
    declaration,
    band.amountBand,
    bandCurrency,
  );

  return (
    <div className="rounded-md border p-3 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">
          {cadence === "custom"
            ? t("cadence.custom", { days: band.frequencyDays })
            : cadence
              ? t(`cadence.${cadence}`)
              : t("cadence.unknown")}
        </span>
        <Badge variant={band.source === "declared" ? "info" : "muted"} className="text-[10px]">
          {t(`source.${band.source}`)}
        </Badge>
        <Badge variant="muted" className="text-[10px]">
          {t(`expectation.${band.documentExpectation ?? "invoice"}`)}
        </Badge>
      </div>

      {band.typicalDayOfMonth !== undefined && (
        <FieldRow label={t("fields.typicalDay")}>
          {t("typicalDayValue", { day: band.typicalDayOfMonth })}
          {band.frequencyConfidence !== undefined && (
            <span className="text-muted-foreground">
              {" · "}
              {t("confidence", { confidence: band.frequencyConfidence })}
            </span>
          )}
        </FieldRow>
      )}

      {expectedAmount && (
        <FieldRow label={t("fields.expectedAmount")}>{expectedAmount}</FieldRow>
      )}

      <FieldRow label={t("fields.lastCharge")}>
        {lastCharge ? (
          <>
            {formatDay(lastCharge.date)}
            <span className="text-muted-foreground">
              {" · "}
              {formatMoney(lastCharge.amount, lastCharge.currency)}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{t("noCharge")}</span>
        )}
      </FieldRow>

      <FieldRow label={t("fields.nextExpected")} icon={<CalendarClock className="h-3 w-3" />}>
        {nextExpected ? (
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Badge variant={WINDOW_VARIANT[windowState]} className="text-[10px]">
              {t(`window.${windowState}`)}
            </Badge>
            <span className="text-muted-foreground">
              {formatDay(nextExpected.from)} – {formatDay(nextExpected.to)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t("window.unknown")}</span>
        )}
      </FieldRow>

      <FieldRow label={t("fields.coverage")}>
        {coverageLevel === "empty" ? (
          <span className="text-muted-foreground">
            {t("coverageEmpty", { months: coverageMonths })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Badge variant={COVERAGE_VARIANT[coverageLevel]} className="text-[10px]">
              {t(`coverageState.${coverageLevel}`)}
            </Badge>
            <span className="text-muted-foreground">
              {t("coverageCounts", {
                charges: coverage.charges,
                withFile: coverage.withFile,
                withCategory: coverage.withCategory,
                missing: coverage.missing,
              })}
            </span>
          </span>
        )}
      </FieldRow>
    </div>
  );
}
