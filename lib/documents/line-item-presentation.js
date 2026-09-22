/**
 * How an unreconciled Line Item itemisation reads on screen (#253).
 *
 * `lineItemsUnreconciled` and `lineItemsUnreconciledRates` are decided by
 * `functions/src/extraction/lineItemReconciliation.ts` and stored on the
 * file; nothing here re-derives either. This module only turns the stored
 * flag into words, so the badge always says exactly what the reconciliation
 * decided — never a stronger or weaker claim than the record carries.
 *
 * Plain data in, plain data out — no React — so the wording is testable with
 * node --test.
 */

/**
 * @param {{ lineItemsUnreconciled?: boolean | null, lineItemsUnreconciledRates?: number[] | null } | null | undefined} file
 * @returns {import("./line-item-presentation").LineItemsUnreconciledPresentation | null}
 */
function describeLineItemsUnreconciled(file) {
  if (!file || file.lineItemsUnreconciled !== true) return null;

  const rates = Array.isArray(file.lineItemsUnreconciledRates)
    ? file.lineItemsUnreconciledRates.filter(
        (rate) => typeof rate === "number" && Number.isFinite(rate),
      )
    : [];

  const rateList = rates.map((rate) => `${rate}%`).join(", ");

  return {
    label: "Line items unreconciled",
    tone: "warning",
    rates,
    text:
      rates.length > 0
        ? `The line items do not reproduce the document total at ${rateList}. Repair the rows, or remove all line items to fall back to the document's own total.`
        : "The line items do not reproduce the document total, and the mismatch could not be localised to one rate. Repair the rows, or remove all line items to fall back to the document's own total.",
  };
}

module.exports = { describeLineItemsUnreconciled };
