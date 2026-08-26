"use client";

import { useTranslations } from "next-intl";
import { CalendarX } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Transaction } from "@/types/transaction";
import { EffectiveBillingCycle, UserPartner } from "@/types/partner";
import {
  isChargeMissingDocument,
  selectEffectiveCycleForAmount,
} from "@/functions/src/matching/billingCycle";
import { cadenceOf } from "@/lib/partners/billing-cycle-presentation";

/**
 * Whether a transaction is a charge of a recurring partner that is missing the
 * document its recurrence expects (#170).
 *
 * Both halves of the question are answered by the shared derivation rather
 * than here: which recurrence the charge belongs to is the band selection the
 * matcher makes, and whether the document is missing is the rule the coverage
 * counts fold — so a row marked in the list is a row `list_recurring_partners`
 * counts as missing, and an SVS instalment or a bank fee (expectation
 * "nothing") is never marked at all.
 */
export function findMissingChargeCycle(
  transaction: Transaction,
  partner: UserPartner | undefined,
): EffectiveBillingCycle | null {
  const effective = partner?.billingCycle?.effective;
  if (!effective?.length) return null;

  const band = selectEffectiveCycleForAmount(effective, transaction.amount);
  if (!band) return null;

  const missing = isChargeMissingDocument({
    hasFile: (transaction.fileIds?.length ?? 0) > 0,
    hasCategory: !!transaction.noReceiptCategoryId,
    documentExpectation: band.documentExpectation,
  });

  return missing ? band : null;
}

interface RecurringChargeMarkerProps {
  /** The recurrence this charge belongs to, from `findMissingChargeCycle`. */
  band: EffectiveBillingCycle;
}

/** The marker itself: a recurring charge whose expected document is not there. */
export function RecurringChargeMarker({ band }: RecurringChargeMarkerProps) {
  const t = useTranslations("billingCycle");
  const cadence = cadenceOf(band.frequencyDays);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          <CalendarX className="h-3.5 w-3.5" />
          {t("marker.label")}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="text-xs">
          {t("marker.tooltip", {
            cadence:
              cadence === "custom" || !cadence
                ? t("cadence.custom", { days: band.frequencyDays })
                : t(`cadence.${cadence}`),
          })}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
