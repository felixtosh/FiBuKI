/**
 * The line item editor's arithmetic (#540).
 *
 * A row's VAT %, VAT amount and gross amount are three views of two numbers,
 * so the editor keeps them coupled: whichever box a person types into, the
 * dependent box follows. "Math can't be messed up" in the panel, and the
 * server enforces the same invariant on whatever any client posts
 * (`enforceLineItemVat` in functions/src/extraction/taxFacts.ts), so this is
 * the convenience and the server is the guarantee.
 *
 * Boxes hold currency units as typed ("26,80" or "26.80"); a box that does not
 * parse leaves its dependants alone rather than clearing them.
 *
 * Plain JS with a .d.ts, like the other lib/files helpers, so node --test can
 * run it without a build.
 */

/**
 * VAT rates in force in the EU and Switzerland (mirrors KNOWN_VAT_RATES in
 * functions/src/extraction/taxFacts.ts). A derived rate snaps to one of these
 * only when it reproduces the typed VAT to the cent.
 */
const KNOWN_VAT_RATES = [
  2.1, 2.6, 3, 3.8, 4, 5, 5.5, 6, 7, 8, 8.1, 9, 10, 12, 13, 13.5, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27,
];

/** No VAT rate in the EU or Switzerland is higher than this. */
const HIGHEST_KNOWN_RATE = 27;

/** @param {string} value @returns {number | null} */
function parseNumber(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {string} value @returns {number | null} cents */
function parseCents(value) {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

/** @param {number} cents */
function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

/** @param {number} rate */
function formatRate(rate) {
  return String(Math.round(rate * 100) / 100);
}

/** @param {number} gross cents @param {number} rate */
function vatInsideGross(gross, rate) {
  return Math.round((gross * rate) / (100 + rate));
}

/**
 * The rate behind a VAT inside a gross, cents: a known rate when one
 * reproduces it to the cent, else the exact figure to one decimal.
 * @param {number} gross @param {number} vat
 * @returns {number | null}
 */
function rateFromVat(gross, vat) {
  if (gross === 0 || vat === 0 || Math.abs(vat) >= Math.abs(gross) || vat * gross < 0) return null;
  for (const rate of KNOWN_VAT_RATES) {
    if (Math.abs(vatInsideGross(Math.abs(gross), rate) - Math.abs(vat)) <= 1) return rate;
  }
  return Math.round(((vat * 100) / (gross - vat)) * 10) / 10;
}

/**
 * @typedef {{ description: string, vatPercent: string, vatAmount: string, amount: string }} EditableRow
 */

/**
 * The row after a person typed `value` into `field`, with the coupled box
 * recomputed.
 *
 *  - VAT % typed: the VAT amount is what that rate puts inside the gross.
 *  - VAT amount typed: the rate is derived from it and the gross.
 *  - Gross typed: the VAT amount follows the rate when there is one, else the
 *    rate follows the VAT amount.
 *
 * @param {EditableRow} row
 * @param {"description" | "vatPercent" | "vatAmount" | "amount"} field
 * @param {string} value
 * @returns {EditableRow}
 */
function updateLineItemRow(row, field, value) {
  const next = { ...row, [field]: value };
  if (field === "description") return next;

  const gross = parseCents(next.amount);
  const rate = parseNumber(next.vatPercent);
  const vat = parseCents(next.vatAmount);

  if (field === "vatPercent") {
    if (value.trim() === "") return { ...next, vatAmount: "" };
    if (gross !== null && rate !== null && rate >= 0 && rate <= 100) {
      next.vatAmount = formatCents(vatInsideGross(gross, rate));
    }
    return next;
  }

  if (field === "vatAmount") {
    if (value.trim() === "") return { ...next, vatPercent: "" };
    if (gross !== null && vat !== null) {
      const derived = rateFromVat(gross, vat);
      if (derived !== null) next.vatPercent = formatRate(derived);
    }
    return next;
  }

  // field === "amount"
  if (gross === null) return next;
  if (rate !== null && rate >= 0 && rate <= 100) {
    next.vatAmount = formatCents(vatInsideGross(gross, rate));
  } else if (vat !== null) {
    const derived = rateFromVat(gross, vat);
    if (derived !== null) next.vatPercent = formatRate(derived);
  }
  return next;
}

/**
 * What is wrong with a row, or null.
 *
 *  - "vatNotInsideAmount": the VAT is as large as the gross, or has the
 *    opposite sign. No rate produces that, so the row cannot be saved.
 *  - "rateOutOfRange": a rate outside 0-100. Cannot be saved.
 *  - "rateUnusual": above every rate the EU and Switzerland charge. A warning
 *    only: a person may be copying a document from elsewhere.
 *
 * @param {EditableRow} row
 * @returns {null | "vatNotInsideAmount" | "rateOutOfRange" | "rateUnusual"}
 */
function lineItemRowProblem(row) {
  const gross = parseCents(row.amount);
  const rate = parseNumber(row.vatPercent);
  const vat = parseCents(row.vatAmount);
  if (rate !== null && (rate < 0 || rate > 100)) return "rateOutOfRange";
  if (gross !== null && vat !== null && vat !== 0 && (Math.abs(vat) >= Math.abs(gross) || vat * gross < 0)) {
    return "vatNotInsideAmount";
  }
  if (rate !== null && rate > HIGHEST_KNOWN_RATE) return "rateUnusual";
  return null;
}

/** @param {ReturnType<typeof lineItemRowProblem>} problem */
function blocksSave(problem) {
  return problem === "vatNotInsideAmount" || problem === "rateOutOfRange";
}

module.exports = { updateLineItemRow, lineItemRowProblem, blocksSave };
