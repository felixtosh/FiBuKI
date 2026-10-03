/**
 * The Trinkgeld figure on one transaction, and the one predicate that decides
 * whether it is possible at all (#317).
 *
 * A tip is a Betriebsausgabe and no part of the VAT base (#172): it is charged
 * on top of the Summe, so the bank line carries `totalGross + tipAmount` and
 * the tip itself carries nothing. A tip that is NOT smaller than the bank line
 * cannot be that — it is a Gesamt transcribed into the Trinkgeld field, or a
 * bank line that is not the whole payment. Either way the figure is wrong, and
 * every reading built on it is wrong with it.
 *
 * The two ends read it in opposite directions and so used to disagree on
 * exactly these transactions. The BMD export refuses one (#194); the UVA
 * ladder took the tip into `invoiceTotal`, found the bank short of it, and
 * scaled the document's rates by `bank / invoiceTotal` as a partial payment —
 * a 54,00 charge carrying a 54,00 tip claimed 2,86 of Vorsteuer, on the side
 * whose figures are the ones actually filed.
 *
 * So the predicate lives here and nowhere else, and both sides import it. What
 * they do with a `true` stays theirs: the export withholds the transaction and
 * names the documents, the UVA puts it on the review list as "impossible-tip".
 *
 * A tip that IS smaller than the bank line can still be one the bank line
 * does not cover (#554): a 3,00 Beleg with a 7,99 tip, paid with 8,00. The
 * reconcile used to read that as a partial payment and scale the claim by
 * `bank / (document + tip)`, returning `ok`. It is either a mistyped tip or a
 * real partial payment of a tipped bill (a split bill), and only a person can
 * say which. `isTipPartialPayment` is that second predicate, shared the same
 * way: the UVA lists the line as "tip-partial-payment" and claims nothing, the
 * export refuses it, and both let it through once an Accepted Partial Payment
 * is live (`./partialPaymentAcceptance`).
 */

import type { UvaFile } from "./types";

export interface TipAssessment {
  /** The tip summed across the transaction's documents, cents. */
  tip: number;
  /**
   * The documents that carry a tip figure. All of them, because correcting
   * one of two 27,00 tips on a 54,00 charge does not make the sum possible.
   */
  tipFiles: UvaFile[];
  /** The tip is not less than the bank line, so it is not a tip. */
  impossible: boolean;
}

/**
 * Read the tip off a transaction's (already converted) documents and judge it
 * against the bank line. `bankGross` is `Math.abs(tx.amount)` on both sides.
 *
 * The boundary is `>=`, not `>`: a tip that EQUALS the payment is the exact
 * misextraction #194 is about — the Gesamt copied into the Trinkgeld field —
 * and it leaves nothing at all for the document's rates to apply to.
 */
export function assessTip(
  files: readonly UvaFile[] | null | undefined,
  bankGross: number
): TipAssessment {
  const tipFiles = (files ?? []).filter((f) => (f.tipAmount ?? 0) > 0);
  const tip = tipFiles.reduce((s, f) => s + (f.tipAmount ?? 0), 0);
  return { tip, tipFiles, impossible: tip > 0 && tip >= bankGross };
}

/**
 * What the bank line is reconciled against when it is the sum of the
 * documents: each document's total plus its tip (#172). Cents, on documents
 * already in the bank's currency.
 */
export function documentsTotalWithTip(files: readonly UvaFile[] | null | undefined): number {
  return (files ?? []).reduce((s, f) => s + (f.totalGross ?? 0) + (f.tipAmount ?? 0), 0);
}

/**
 * Is the bank line short of what the tipped documents add up to (#554)?
 *
 * `reconcileTotal` is the figure the reconcile compares the bank line with:
 * `documentsTotalWithTip` on the converted documents, or the payment itself
 * for a document converted at a published rate (#92), which therefore never
 * reads as short. An impossible tip is not also a partial payment: it is
 * refused on its own predicate first, and stays so with a ruling.
 *
 * `toleranceCents` is the reconcile's own (`RECONCILE_TOLERANCE_CENTS`), so
 * this fires exactly where the reconcile would otherwise take R2.
 */
export function isTipPartialPayment(
  tip: TipAssessment,
  bankGross: number,
  reconcileTotal: number,
  toleranceCents: number
): boolean {
  return tip.tip > 0 && !tip.impossible && reconcileTotal - bankGross > toleranceCents;
}
