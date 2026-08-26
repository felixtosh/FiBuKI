"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import { toDateSafe } from "@/lib/utils";
import type { EffectiveBillingCycle, UserPartner } from "@/types/partner";
import { readBankOriginalAmount } from "@/functions/src/fx/bankOriginalAmount";
import {
  CHARGE_SCAN_LIMIT,
  DEFAULT_COVERAGE_MONTHS,
  nextExpectedCharge,
  selectEffectiveCycleForAmount,
  summarizeChargeCoverage,
  type ChargeCoverage,
  type ExpectedChargeWindow,
} from "@/functions/src/matching/billingCycle";

/** One charge of a recurring partner, as the panel reads it off the transaction. */
export interface PartnerCharge {
  id: string;
  date: Date;
  /**
   * Absolute, in the currency the vendor billed: the bank's own stated
   * original when it has one (#112), never a conversion.
   */
  amount: number;
  currency: string;
  /** Signed, in the account's currency — the amount the bands were learned on. */
  bandAmount: number;
  accountCurrency: string;
  hasFile: boolean;
  hasCategory: boolean;
}

/** One recurrence of the partner, with what the panel shows about it. */
export interface RecurrenceView {
  band: EffectiveBillingCycle;
  lastCharge: PartnerCharge | null;
  nextExpected: ExpectedChargeWindow | null;
  coverage: ChargeCoverage;
}

export interface PartnerBillingCycleView {
  isRecurring: boolean;
  recurrences: RecurrenceView[];
  /** How far back the coverage counts reach. */
  coverageMonths: number;
  loading: boolean;
}

function toCharge(doc: QueryDocumentSnapshot): PartnerCharge | null {
  const data = doc.data();
  const date = toDateSafe(data.date);
  if (!date) return null;

  const billed = readBankOriginalAmount(data._original?.rawRow);
  const accountCurrency = (data.currency as string) || "EUR";
  const bandAmount = typeof data.amount === "number" ? data.amount : 0;

  return {
    id: doc.id,
    date,
    amount: billed ? billed.amount : Math.abs(bandAmount),
    currency: billed ? billed.currency : accountCurrency,
    bandAmount,
    accountCurrency,
    hasFile: ((data.fileIds as string[] | undefined) ?? []).length > 0,
    hasCategory: !!data.noReceiptCategoryId,
  };
}

/**
 * The billing cycle of one partner, as the detail panel shows it: per
 * recurrence the last charge seen, the next expected window and the document
 * coverage of its charges.
 *
 * Nothing here decides anything about the cycle. The bands come from the
 * stored effective view, and the three questions the panel asks about them are
 * answered by the same pure functions `list_recurring_partners` calls
 * (`selectEffectiveCycleForAmount`, `nextExpectedCharge`,
 * `summarizeChargeCoverage`) over the same window, so the panel and the MCP
 * tool cannot report a partner differently.
 *
 * Charges are read by `partnerId` only — never `bankPartnerId`: the card
 * descriptor's partner is not the supplier whose cycle this is.
 */
export function usePartnerBillingCycle(
  partner: Pick<UserPartner, "id" | "billingCycle">,
): PartnerBillingCycleView {
  const { userId } = useAuth();
  const partnerId = partner.id;

  const effective = useMemo(
    () => partner.billingCycle?.effective ?? [],
    [partner.billingCycle],
  );
  const isRecurring = effective.length > 0;

  const [charges, setCharges] = useState<PartnerCharge[]>([]);
  const [loading, setLoading] = useState(isRecurring);

  useEffect(() => {
    if (!userId || !isRecurring) {
      setCharges([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const snapshot = await getDocs(
          query(
            collection(db, "transactions"),
            where("userId", "==", userId),
            where("partnerId", "==", partnerId),
            orderBy("date", "desc"),
            limit(CHARGE_SCAN_LIMIT),
          ),
        );
        if (cancelled) return;
        setCharges(
          snapshot.docs
            .map(toCharge)
            .filter((charge): charge is PartnerCharge => charge !== null),
        );
      } catch (error) {
        console.error("Failed to load partner charges:", error);
        if (!cancelled) setCharges([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, partnerId, isRecurring]);

  return useMemo(() => {
    const now = Date.now();
    const rangeStart = new Date(now);
    rangeStart.setMonth(rangeStart.getMonth() - DEFAULT_COVERAGE_MONTHS);

    // A charge dated ahead of today is not one that has been seen.
    const seen = charges.filter((charge) => charge.date.getTime() <= now);
    const inRange = seen.filter(
      (charge) => charge.date.getTime() >= rangeStart.getTime(),
    );

    // Which recurrence a charge belongs to is the same band selection the
    // matcher makes. A charge that belongs to no band — a one-off payment to a
    // recurring vendor — is nobody's recurrence, so it cannot become the
    // weekly band's last charge.
    const bandOf = (charge: PartnerCharge) =>
      selectEffectiveCycleForAmount(effective, charge.bandAmount);

    const recurrences = effective.map((band) => {
      const ofBand = (charge: PartnerCharge) => bandOf(charge) === band;
      const lastCharge = seen.find(ofBand) ?? null;
      return {
        band,
        lastCharge,
        nextExpected: nextExpectedCharge(lastCharge?.date ?? null, band),
        coverage: summarizeChargeCoverage(
          inRange.filter(ofBand).map((charge) => ({
            hasFile: charge.hasFile,
            hasCategory: charge.hasCategory,
            documentExpectation: band.documentExpectation,
          })),
        ),
      };
    });

    return {
      isRecurring,
      recurrences,
      coverageMonths: DEFAULT_COVERAGE_MONTHS,
      loading,
    };
  }, [charges, effective, isRecurring, loading]);
}
