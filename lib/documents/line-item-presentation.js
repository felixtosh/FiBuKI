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
 * The one VAT rate the File's document carries, by the rule
 * `singleDocumentRate` in functions/src/extraction/lineItemReconciliation.ts
 * applies to a stored record (#511): a stated rate, and no row at another.
 *
 * @param {{ extractedVatPercent?: number | null, extractedLineItems?: Array<{ vatPercent?: number | null }> | null }} file
 * @returns {number | null}
 */
function singleDocumentRate(file) {
  const rate = file.extractedVatPercent;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  const rows = Array.isArray(file.extractedLineItems) ? file.extractedLineItems : [];
  return rows.every((row) => row?.vatPercent == null || row.vatPercent === rate) ? rate : null;
}

/**
 * @param {{
 *   lineItemsUnreconciled?: boolean | null,
 *   lineItemsUnreconciledRates?: number[] | null,
 *   extractedRateGroups?: Array<{ rate: number }> | null,
 *   extractedVatPercent?: number | null,
 *   extractedLineItems?: Array<{ vatPercent?: number | null }> | null,
 * } | null | undefined} file
 * @returns {import("./line-item-presentation").LineItemsUnreconciledPresentation | null}
 */
function describeLineItemsUnreconciled(file) {
  if (!file || file.lineItemsUnreconciled !== true) return null;

  const rates = Array.isArray(file.lineItemsUnreconciledRates)
    ? file.lineItemsUnreconciledRates.filter(
        (rate) => typeof rate === "number" && Number.isFinite(rate),
      )
    : [];

  // The flag only blocks a File whose VAT has no other reading. A printed VAT
  // block is one; a single-rate document is another, its VAT being its total
  // at that rate (#511). Then the rows are a label nobody's VAT depends on.
  const hasPrintedBlock =
    Array.isArray(file.extractedRateGroups) && file.extractedRateGroups.length > 0;
  const singleRate = hasPrintedBlock ? null : singleDocumentRate(file);
  if (hasPrintedBlock || singleRate !== null) {
    return {
      label: "Line items don't add up",
      tone: "neutral",
      rates,
      text: hasPrintedBlock
        ? "The line items do not add up to the document total. The VAT comes from the document's printed VAT summary instead, so nothing is blocked. Repair the rows only if you want the itemisation to match."
        : `The line items do not add up to the document total. The document has one VAT rate (${singleRate}%), so its VAT comes from the total instead and nothing is blocked. Repair the rows only if you want the itemisation to match.`,
    };
  }

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
