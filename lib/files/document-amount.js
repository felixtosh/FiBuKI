/**
 * The amount a File's document states (#504).
 *
 * The stored `extractedAmount` is the document total the server extracted
 * and reconciled, and it is what matching and the remainder read. Every
 * surface that shows a File's amount shows this figure, so the two can never
 * disagree on one screen.
 *
 * The client used to re-derive the figure from the line items, guessing per
 * File whether the rows were net or gross from how well each row's VAT fit
 * each reading. One bad row VAT was enough to tip the guess and show 25,34 €
 * on a 19,00 € invoice. Net rows are converted to gross by extraction itself
 * (fork #137), so there is nothing left for the client to convert.
 *
 * The row sum is a fallback only for a File with no stored total, and never
 * from rows flagged as contradicting the document (#203).
 *
 * @param {{
 *   extractedAmount?: number | null,
 *   extractedLineItems?: Array<{ amount: number }> | null,
 *   lineItemsUnreconciled?: boolean | null,
 * }} file
 * @returns {number | null} cents
 */
function fileDocumentAmount(file) {
  if (file.extractedAmount != null) return file.extractedAmount;

  const lineItems = file.extractedLineItems;
  if (!Array.isArray(lineItems) || lineItems.length === 0 || file.lineItemsUnreconciled) {
    return null;
  }
  return lineItems.reduce((sum, item) => sum + item.amount, 0);
}

module.exports = { fileDocumentAmount };
