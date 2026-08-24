/**
 * How a partner's billing cycle reads on screen (#170).
 *
 * The cycle itself is decided elsewhere and never re-derived here:
 * `functions/src/matching/billingCycle.ts` learns it, resolves declared over
 * learned, computes the next expected window and folds the coverage counts.
 * This module only answers the questions a surface asks about the result —
 * which named cadence a frequency reads as, where today sits in an expected
 * window, how complete a recurrence's documentation is — and it answers them
 * as tokens, not as sentences: the words live in `messages/{de,en}.json` and
 * are resolved by the component through next-intl.
 *
 * Plain data in, plain data out — no React, no Firestore, no i18n — so the
 * whole vocabulary is testable with node --test.
 */

/**
 * The named cadences, in days. Mirrors `CADENCE_DAYS` in
 * `functions/src/matching/billingCycle.ts`, which is what a declaration
 * stores; a learned frequency is a raw interval and only ever *reads* as one
 * of these.
 */
const CADENCE_DAYS = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

/**
 * How far a learned frequency may sit from a named cadence and still read as
 * it. A partner charged on the 1st learns 28, 30 or 31 days depending on the
 * months sampled; all three are "monthly" to a reader. Wide enough for that,
 * narrow enough that a fortnightly partner (14) stays "every 14 days".
 */
const CADENCE_TOLERANCE_DAYS = 3;

/**
 * Which cadence a frequency reads as: one of the four names, or `custom` for
 * a partner on its own interval. Null when there is no usable frequency —
 * the caller has nothing to render, not a cadence of zero days.
 *
 * @param {unknown} frequencyDays
 * @returns {import("./billing-cycle-presentation").CadenceName | null}
 */
function cadenceOf(frequencyDays) {
  if (typeof frequencyDays !== "number" || !Number.isFinite(frequencyDays)) return null;
  if (frequencyDays <= 0) return null;

  for (const [name, days] of Object.entries(CADENCE_DAYS)) {
    if (Math.abs(frequencyDays - days) <= CADENCE_TOLERANCE_DAYS) {
      return /** @type {import("./billing-cycle-presentation").CadenceName} */ (name);
    }
  }
  return "custom";
}

/**
 * Whether a partner bills on a schedule at all — the predicate behind the
 * partners list's recurring filter.
 *
 * It reads the effective view, the same field `list_recurring_partners`
 * filters on, so the list and the MCP tool cannot disagree about who is
 * recurring. A partner carrying only a learned half that resolved to nothing
 * is not recurring.
 *
 * @param {{ billingCycle?: { effective?: unknown } } | null | undefined} partner
 * @returns {boolean}
 */
function isRecurringPartner(partner) {
  const effective = partner?.billingCycle?.effective;
  return Array.isArray(effective) && effective.length > 0;
}

/**
 * Where today sits relative to the next expected charge.
 *
 * `overdue` is deliberately only reached past the far edge of the window: a
 * charge that is merely late within its own learned variance is `due`, not a
 * finding against the vendor.
 *
 * @param {{ from?: Date, to?: Date } | null | undefined} window
 * @param {Date} today
 * @returns {import("./billing-cycle-presentation").ChargeWindowState}
 */
function chargeWindowState(window, today) {
  const now = today instanceof Date ? today.getTime() : NaN;
  if (Number.isNaN(now)) return "unknown";
  if (!window || !(window.from instanceof Date) || !(window.to instanceof Date)) {
    return "unknown";
  }
  if (Number.isNaN(window.from.getTime()) || Number.isNaN(window.to.getTime())) {
    return "unknown";
  }

  if (now < window.from.getTime()) return "upcoming";
  if (now > window.to.getTime()) return "overdue";
  return "due";
}

/**
 * How completely a recurrence's charges carry what they are expected to.
 *
 * `empty` is its own state rather than a shade of `complete`: a recurrence
 * with no charge in the coverage window has nothing to be complete about, and
 * showing it as fully covered would read as a claim nobody made.
 *
 * @param {{ charges?: number, missing?: number } | null | undefined} coverage
 * @returns {import("./billing-cycle-presentation").CoverageState}
 */
function coverageState(coverage) {
  const charges = coverage?.charges ?? 0;
  if (!charges) return "empty";

  const missing = coverage?.missing ?? 0;
  if (missing === 0) return "complete";
  if (missing >= charges) return "none";
  return "partial";
}

/**
 * The declaration behind an effective recurrence, or null when the recurrence
 * was learned rather than declared.
 *
 * The effective view carries the frequency and the expectation but not the
 * amount band's edges, which only the declaration has — this is how the panel
 * gets back to them. The match is by amount band, the same key
 * `resolveEffectiveCycles` matched on; a lone declaration needs no band
 * because there is nothing it could be confused with.
 *
 * @param {ReadonlyArray<{ amountBand?: number }> | null | undefined} declared
 * @param {{ source?: string, amountBand?: number } | null | undefined} band
 */
function declarationFor(declared, band) {
  if (!band || band.source !== "declared") return null;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  if (declared.length === 1) return declared[0];

  return (
    declared.find(
      (entry) => entry?.amountBand !== undefined && entry.amountBand === band.amountBand
    ) ?? null
  );
}

module.exports = {
  CADENCE_DAYS,
  CADENCE_TOLERANCE_DAYS,
  cadenceOf,
  isRecurringPartner,
  chargeWindowState,
  coverageState,
  declarationFor,
};
