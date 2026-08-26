/**
 * FX plausibility (fork #87).
 *
 * A foreign-currency document (USD 24.00) never equals its EUR bank line
 * (EUR 20.86) numerically, so anything that compares the two raw numbers
 * silently fails — the matcher never awarded amount points, and the UVA
 * adapter read the USD figures as EUR. This module answers one question
 * for both consumers: "is bank/document a believable exchange rate for
 * this currency pair?"
 *
 * The reference rates below are coarse anchors used ONLY to gate
 * plausibility. They never convert anything: the effective rate actually
 * paid is always derived from the real pair (bank amount / document
 * amount) on the payment date. Card FX markups (1-3%) and several years of
 * market drift fit inside the tolerances, which is why they are wide; a
 * genuinely historical outlier lands in the worklist, never in a figure.
 * Unknown codes have no anchor and are never guessed here — the scorer
 * falls back to its numeric ladder for those, the UVA surfaces them.
 */

import { normalizeCurrencyForDisplay } from "./currencyNormalization";

/** Approximate value of one unit of the currency in EUR (anchor, not a feed). */
export const FX_REFERENCE_TO_EUR: Record<string, number> = {
  EUR: 1,
  USD: 0.88,
  GBP: 1.17,
  CHF: 1.07,
  SEK: 0.09,
  NOK: 0.087,
  DKK: 0.134,
  PLN: 0.235,
  CZK: 0.04,
  HUF: 0.0025,
  JPY: 0.0058,
  CAD: 0.63,
  AUD: 0.58,
};

/** Relative deviation from the reference that still counts as a tight FX match. */
export const FX_TIGHT_TOLERANCE = 0.05;
/**
 * Relative deviation from the reference that still counts as plausible at
 * all. Wide on purpose: the anchors are current-era, and USD sat at parity
 * with EUR in 2022 (~16% off today's anchor). A pair that falls outside
 * this band is not silently mis-scored — the matcher awards no amount
 * points and the UVA lists it, so a wider band costs little.
 */
export const FX_LOOSE_TOLERANCE = 0.2;

export type FxBand = "tight" | "loose";

export interface FxAssessment {
  /** True when the two currencies differ after normalization. */
  mismatch: boolean;
  /** Bank amount per document unit (|tx| / |doc|); null when not assessable. */
  impliedRate: number | null;
  /** Anchor rate for the pair; null when either currency is unknown. */
  referenceRate: number | null;
  /** |implied - reference| / reference; null when either side is missing. */
  deviation: number | null;
  /** Plausibility verdict; null when same currency, unknown pair, or implausible. */
  band: FxBand | null;
}

/**
 * A missing currency is read as EUR here, and only here: an amount with no
 * currency on an Austrian instance is overwhelmingly EUR, and the alternative
 * would be to declare every such pair unanchored. An unrecognised code is NOT
 * read as EUR — normalizeCurrencyForDisplay preserves it, which is what lets an
 * unanchored pair be surfaced rather than silently treated as same-currency.
 */
export function normalizeCurrency(c?: string | null): string {
  return normalizeCurrencyForDisplay(c);
}

export function isSameCurrency(a?: string | null, b?: string | null): boolean {
  return normalizeCurrency(a) === normalizeCurrency(b);
}

/**
 * Reference rate for converting one unit of `from` into `to`, or null when
 * either currency has no anchor.
 */
export function referenceRate(from: string, to: string): number | null {
  const f = FX_REFERENCE_TO_EUR[normalizeCurrency(from)];
  const t = FX_REFERENCE_TO_EUR[normalizeCurrency(to)];
  if (!f || !t) return null;
  return f / t;
}

/**
 * Assess whether `txAmount` in `txCurrency` is a plausible payment for a
 * document of `docAmount` in `docCurrency`. Signs are ignored.
 */
export function assessImpliedFx(
  docAmount: number,
  docCurrency: string | null | undefined,
  txAmount: number,
  txCurrency: string | null | undefined
): FxAssessment {
  const mismatch = !isSameCurrency(docCurrency, txCurrency);
  const none: FxAssessment = {
    mismatch,
    impliedRate: null,
    referenceRate: null,
    deviation: null,
    band: null,
  };
  if (!mismatch) return none;

  const absDoc = Math.abs(docAmount);
  const absTx = Math.abs(txAmount);
  if (!absDoc || !absTx) return none;

  const implied = absTx / absDoc;
  const ref = referenceRate(normalizeCurrency(docCurrency), normalizeCurrency(txCurrency));
  if (ref === null) return { ...none, impliedRate: implied };

  const deviation = Math.abs(implied - ref) / ref;
  const band: FxBand | null =
    deviation <= FX_TIGHT_TOLERANCE
      ? "tight"
      : deviation <= FX_LOOSE_TOLERANCE
        ? "loose"
        : null;
  return { mismatch, impliedRate: implied, referenceRate: ref, deviation, band };
}
