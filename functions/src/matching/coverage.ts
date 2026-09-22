/**
 * Coverage and the Remainder (#239).
 *
 * **Coverage** is how much of a Transaction its connected Files explain.
 * The **Remainder** is the part not yet explained. Two words, one derivation,
 * read by the scorers and by both detail panels — before this module each of
 * the three worked the same subtraction out for itself, with its own
 * tolerance, and only the scorers' answer ever reached matching.
 *
 * The module is deliberately dependency-free. The detail panels are client
 * components and import it straight from `@/functions/src/matching/coverage`;
 * `transactionScoring.ts`, the natural home for the two tolerances, pulls in
 * `firebase-admin/firestore`, which has no business in a browser bundle. So
 * the literals live here and `SCORING_CONFIG` re-exposes them under the same
 * names — one value each, reachable from both sides.
 *
 * All amounts are integer cents.
 */

/**
 * Is this Transaction documented? A ratio, because it has to hold for a 12 EUR
 * line and a 12 000 EUR line alike. This is the coverage tolerance that has
 * gated auto-connect since the beginning, written the way round it is read.
 */
export const COVERAGE_RATIO = 0.9;

/**
 * Does this File close the Remainder? Absolute, because the gaps it forgives —
 * rounding and a printed Trinkgeld (#172) — are absolute. This is the 1 EUR
 * the "Difference" line in both detail panels used to hardcode.
 */
export const REMAINDER_CLOSE_TOLERANCE = 100;

export interface Coverage {
  /** The Transaction's own amount, as a magnitude. */
  transactionAmount: number;
  /** What the connected Files explain, as a magnitude. */
  documentedAmount: number;
  /**
   * The part not yet explained. Negative when the connected Files add up to
   * more than the bank line — over-documented, not fully documented twice.
   */
  remainder: number;
  /** documentedAmount / transactionAmount. Zero for a zero-amount line. */
  ratio: number;
  /** Documented to at least COVERAGE_RATIO: no further File should auto-connect. */
  isCovered: boolean;
  /** The figure a further candidate File should be scored against. */
  scoreAgainst: number;
  /** True when `scoreAgainst` is the Remainder rather than the full amount. */
  againstRemainder: boolean;
}

/**
 * The one derivation. `documentedAmount` is what `documentedAmountOf` returns
 * for the Files already connected to this Transaction.
 */
export function deriveCoverage(
  transactionAmount: number,
  documentedAmount: number
): Coverage {
  const absTransaction = Math.abs(transactionAmount);
  const absDocumented = Math.abs(documentedAmount);
  const remainder = absTransaction - absDocumented;
  const ratio = absTransaction > 0 ? absDocumented / absTransaction : 0;

  // At or below zero the Transaction is fully documented, so a further
  // candidate is scored against the full amount: nothing may earn a perfect
  // hit against a Remainder of 0,00.
  const againstRemainder = absDocumented > 0 && remainder > 0;

  return {
    transactionAmount: absTransaction,
    documentedAmount: absDocumented,
    remainder,
    ratio,
    isCovered: ratio >= COVERAGE_RATIO,
    scoreAgainst: againstRemainder ? remainder : absTransaction,
    againstRemainder,
  };
}

/**
 * Sum the payment totals of a Transaction's connected Files, as a magnitude.
 * Feed it `filePaymentTotal(...)` per File — Summe plus printed Trinkgeld —
 * so a tip keeps counting towards Coverage the same way it counts towards a
 * Match (#172). A File with no extracted amount contributes nothing.
 */
export function documentedAmountOf(
  paymentTotals: Array<number | null | undefined>
): number {
  let total = 0;
  for (const payment of paymentTotals) {
    if (payment != null) total += Math.abs(payment);
  }
  return total;
}

/**
 * Is this gap small enough to call the Remainder closed? The single reading of
 * REMAINDER_CLOSE_TOLERANCE — the scorers ask it of `remainder - candidate`,
 * the detail panels of the figure they print.
 */
export function isRemainderClosed(gap: number): boolean {
  return Math.abs(gap) <= REMAINDER_CLOSE_TOLERANCE;
}

/**
 * What the bank was charged for a document: the VAT-bearing total plus any
 * Trinkgeld, whether the document printed it (#172) or a person recorded the
 * one it never printed (#217).
 *
 * `extractedAmount` is the Summe the printed rate groups add up to, which is
 * deliberately NOT the figure on the bank line for a restaurant Beleg with a
 * terminal-added tip. Every comparison against a bank amount goes through
 * here so the two readings cannot drift apart.
 *
 * Lives here rather than in `transactionScoring.ts` (which re-exports it, so
 * every existing import site is unchanged) because Coverage is the other
 * consumer, and the detail panels need it without the Admin SDK.
 */
export function filePaymentTotal(
  extractedAmount: number | null | undefined,
  extractedTipAmount: number | null | undefined
): number | null {
  if (extractedAmount == null) return null;
  const tip = extractedTipAmount ?? 0;
  if (tip <= 0) return extractedAmount;
  // A credit note carries the sign on the document total; the tip follows it.
  return extractedAmount < 0 ? extractedAmount - tip : extractedAmount + tip;
}
