/**
 * Corrections: money moving back for something already booked (#564,
 * ADR-0010).
 *
 * A supplier's refund of a purchase is money in, and the User's refund to a
 * customer is money out, so the bank sign says the opposite of what each one
 * is. § 16 Abs 1 has each side correct what it originally did: the buyer the
 * Vorsteuer it claimed (KZ 067), the seller the tax it owed (KZ 000 and the
 * rate field). This module holds the pure half of that:
 *
 *  - `bookingSide`, the one place a Transaction's side is decided. The UVA,
 *    the per-transaction VAT and the BMD Export all read it.
 *  - `correctionAmounts`, what a refund reverses: refund ÷ original gross ×
 *    what the original claimed, per rate, capped at what earlier refunds left.
 *  - `priorCorrectedOf`, what a run of earlier refunds of one original already
 *    took back, on the same formula, so the cap reads the figures they booked.
 *
 * Nothing here queries. The period run resolves the link, the original's claim
 * and the earlier refunds, and hands them in on `UvaTransaction.correction`.
 */

import type { BookingSide, CorrectionRateGroup, UvaCorrection } from "./types";

/**
 * Which way a Transaction books. A linked correction books on its original's
 * side; everything else, an unlinked correction included, by the bank sign —
 * an unlinked refund keeps today's safe default until it is linked (D1).
 */
export function bookingSide(tx: {
  amount: number;
  correction?: UvaCorrection | null;
}): BookingSide {
  const c = tx.correction;
  if (c?.status === "linked") {
    return c.kind === "purchase" ? "purchase-correction" : "sale-correction";
  }
  // A zero line books as a sale, as the BMD Export always booked it; the UVA
  // has nothing to claim on it either way.
  return tx.amount < 0 ? "purchase" : "sale";
}

/** True for the two correction sides. */
export function isCorrectionSide(side: BookingSide): side is "purchase-correction" | "sale-correction" {
  return side === "purchase-correction" || side === "sale-correction";
}

export interface CorrectionAmounts {
  /** Per rate, what this refund reverses, cents (positive). Rate-0 and empty groups are left out. */
  groups: CorrectionRateGroup[];
  /** VAT the refund would reverse beyond what the original still had, cents. */
  excessVat: number;
  /** The VAT before the cap, the figure a printed credit note is checked against. */
  uncappedVat: number;
}

/**
 * What one refund reverses (ADR-0010 rule 3): refund ÷ original gross × what
 * the original claimed, per rate, rounded per Transaction, and capped at what
 * the original claimed minus what earlier refunds already took back.
 *
 * An original that claimed nothing (0%, foreign VAT, non-claimable) corrects
 * nothing: its groups carry no VAT, so they are dropped here and never reach
 * a Kennzahl — a 0% purchase refund never lands in KZ 011.
 */
export function correctionAmounts(
  refundGross: number,
  claimed: CorrectionRateGroup[],
  originalGross: number,
  priorCorrected: CorrectionRateGroup[] = []
): CorrectionAmounts {
  const groups: CorrectionRateGroup[] = [];
  let excessVat = 0;
  let uncappedVat = 0;
  if (originalGross <= 0 || refundGross <= 0) return { groups, excessVat, uncappedVat };

  for (const g of claimed) {
    if (g.rate === 0 || g.vat <= 0) continue;
    const prior = priorCorrected.find((p) => p.rate === g.rate);
    const rawVat = Math.round((refundGross * g.vat) / originalGross);
    const rawNet = Math.round((refundGross * g.net) / originalGross);
    uncappedVat += rawVat;
    const vat = Math.min(rawVat, Math.max(g.vat - (prior?.vat ?? 0), 0));
    const net = Math.min(rawNet, Math.max(g.net - (prior?.net ?? 0), 0));
    excessVat += rawVat - vat;
    if (vat === 0 && net === 0) continue;
    groups.push({ rate: g.rate, net, vat });
  }
  return { groups, excessVat, uncappedVat };
}

/**
 * What a run of earlier refunds of one original already took back, per rate.
 * Each is computed exactly as it was booked, in order, so the cap a later
 * refund meets is the one the earlier ones actually left.
 */
export function priorCorrectedOf(
  earlierRefundGrosses: number[],
  claimed: CorrectionRateGroup[],
  originalGross: number
): CorrectionRateGroup[] {
  let prior: CorrectionRateGroup[] = [];
  for (const refund of earlierRefundGrosses) {
    const { groups } = correctionAmounts(refund, claimed, originalGross, prior);
    prior = addGroups(prior, groups);
  }
  return prior;
}

function addGroups(a: CorrectionRateGroup[], b: CorrectionRateGroup[]): CorrectionRateGroup[] {
  const byRate = new Map<number, CorrectionRateGroup>();
  for (const g of [...a, ...b]) {
    const acc = byRate.get(g.rate) ?? { rate: g.rate, net: 0, vat: 0 };
    acc.net += g.net;
    acc.vat += g.vat;
    byRate.set(g.rate, acc);
  }
  return [...byRate.values()].sort((x, y) => y.rate - x.rate);
}
