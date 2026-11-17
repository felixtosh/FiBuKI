"use client";

/**
 * The Booking Accounts (Sachkonten) of a File or a Transaction, read-only
 * (#785): the accounts another bookkeeping tool booked it to, kept by an
 * import. Renders nothing when there are none, so items that never came from
 * another tool look as they always did.
 */

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/ui/detail-panel-primitives";
import { formatCurrency } from "@/lib/utils";
import type { BookingAccount } from "@/functions/src/bookingAccounts/types";

export function BookingAccountsSection({ bookingAccounts }: { bookingAccounts?: BookingAccount[] }) {
  const t = useTranslations("bookingAccounts");
  if (!bookingAccounts || bookingAccounts.length === 0) return null;

  return (
    <section className="space-y-2" data-testid="booking-accounts">
      <SectionHeader>{t("title")}</SectionHeader>
      <ul className="space-y-1.5">
        {bookingAccounts.map((account, i) => (
          <li key={`${account.accountNumber}-${i}`} className="text-sm space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono tabular-nums">{account.accountNumber}</span>
              <span className="truncate">{account.accountName}</span>
              {account.isAsset ? <Badge variant="info">{t("asset")}</Badge> : null}
              {account.isGwg ? <Badge variant="info">{t("gwg")}</Badge> : null}
              {account.amount !== null ? (
                <span className="ml-auto tabular-nums">{formatCurrency(account.amount)}</span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {account.vatPercent !== null ? <span>{t("rate", { rate: account.vatPercent })}</span> : null}
              {account.skr03 || account.skr04 ? (
                <span>{t("other", { numbers: otherCharts(account) })}</span>
              ) : null}
              <span>{t(`origin.${account.origin}`)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function otherCharts(account: BookingAccount): string {
  return [account.skr03 && `SKR03 ${account.skr03}`, account.skr04 && `SKR04 ${account.skr04}`]
    .filter(Boolean)
    .join(", ");
}
